-- 生成物。手で直さない。元は migrations/*.sql（SQLite・D1）で、scripts/pg-ddl.mjs が作る（FR-CORE-DATA-017）
-- 元の移行の指紋: sha256 da1397bdcf276c793c2ad64d35b1f54e0a036c189a89a2dc2b1649d569582e6f
-- 表 389・索引 256・トリガー 912（共通の関数 617・PL/pgSQL の関数 295）・FK 952・IDENTITY 238
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

-- ===== 0012_planning_project_classification.sql =====
CREATE TABLE earning_types (
  code text COLLATE "C" PRIMARY KEY CHECK (length(code) BETWEEN 1 AND 40 AND ltrim(code, 'abcdefghijklmnopqrstuvwxyz_') = ''),
  label text COLLATE "C" NOT NULL UNIQUE CHECK (length(trim(label)) BETWEEN 1 AND 40),
  project_type text COLLATE "C" NOT NULL CHECK (project_type IN ('field_contract', 'production', 'acquisition', 'agency', 'sw_contract', 'contract_production')),
  profit_source bigint NOT NULL UNIQUE CHECK (profit_source > 0),
  base_amount_kind text COLLATE "C" NOT NULL CHECK (base_amount_kind IN ('rights_revenue', 'production_cost')),
  rate_source text COLLATE "C" NOT NULL CHECK (rate_source IN ('project', 'contract')),
  sort_order bigint NOT NULL UNIQUE CHECK (sort_order >= 0)
);
CREATE TABLE action_steps (
  code text COLLATE "C" PRIMARY KEY CHECK (length(code) BETWEEN 1 AND 60 AND ltrim(code, 'abcdefghijklmnopqrstuvwxyz0123456789_') = ''),
  label text COLLATE "C" NOT NULL CHECK (length(trim(label)) BETWEEN 1 AND 60),
  parent_code text COLLATE "C",
  sort_order bigint NOT NULL CHECK (sort_order >= 0),
  CHECK (parent_code IS NULL OR parent_code <> code)
);
CREATE FUNCTION action_steps_two_levels_fn() RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  IF (NEW.parent_code IS NOT NULL AND (SELECT s.parent_code FROM action_steps s WHERE s.code = NEW.parent_code) IS NOT NULL) IS NOT TRUE THEN RETURN NEW; END IF;
  RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'action step detail must hang under a top step';
  RETURN NEW;
END
$fn$;
CREATE TRIGGER action_steps_two_levels BEFORE INSERT ON action_steps FOR EACH ROW EXECUTE FUNCTION action_steps_two_levels_fn();
CREATE TRIGGER action_steps_fixed BEFORE UPDATE OF code, parent_code ON action_steps FOR EACH ROW EXECUTE FUNCTION lite_reject_change('action step code and parent are fixed');
CREATE TABLE project_stages (
  code text COLLATE "C" PRIMARY KEY CHECK (length(code) BETWEEN 1 AND 40 AND ltrim(code, 'abcdefghijklmnopqrstuvwxyz_') = ''),
  label text COLLATE "C" NOT NULL UNIQUE CHECK (length(trim(label)) BETWEEN 1 AND 40),
  yomi bigint UNIQUE CHECK (yomi IS NULL OR yomi > 0),
  probability_bps bigint NOT NULL CHECK (lite_typeof(probability_bps) = 'integer' AND probability_bps BETWEEN 0 AND 10000),
  definition text COLLATE "C" NOT NULL CHECK (length(trim(definition)) BETWEEN 1 AND 500),
  step_code text COLLATE "C",
  requires_reason bigint NOT NULL DEFAULT 0 CHECK (requires_reason IN (0, 1)),
  sort_order bigint NOT NULL UNIQUE CHECK (sort_order >= 0)
);
CREATE TABLE project_stage_meanings (
  stage_code text COLLATE "C" NOT NULL,
  earning_type text COLLATE "C" NOT NULL,
  meaning text COLLATE "C" NOT NULL CHECK (length(trim(meaning)) BETWEEN 1 AND 500),
  PRIMARY KEY (stage_code, earning_type)
);
INSERT INTO earning_types (code, label, project_type, profit_source, base_amount_kind, rate_source, sort_order) VALUES
  ('acquisition', '買付', 'acquisition', 4, 'rights_revenue', 'project', 1),
  ('consignment', '販売委託', 'agency', 5, 'rights_revenue', 'project', 2),
  ('own_investment', '自社出資', 'production', 2, 'rights_revenue', 'project', 3),
  ('committee', '製作委員会', 'production', 3, 'rights_revenue', 'project', 4),
  ('contract_work', '制作受託', 'contract_production', 1, 'production_cost', 'contract', 5);
INSERT INTO action_steps (code, label, parent_code, sort_order) VALUES
  ('meeting', '面談', NULL, 1),
  ('proposal', '提案', NULL, 2),
  ('contract', '契約', NULL, 3);
INSERT INTO project_stages (code, label, yomi, probability_bps, definition, step_code, requires_reason, sort_order) VALUES
  ('declined', '見送り', NULL, 0, '進めないと決めた', NULL, 1, 0),
  ('memo', '企画メモ', 1, 1000, '相手が企画・課題を認識し、「やる意味がある」の言質を得た', NULL, 0, 1),
  ('met', '面談済み', 2, 2000, '相手が自社と組む価値を理解した言質を得た', 'meeting', 0, 2),
  ('exploring', '条件の探り', 3, 3000, '予算割・試算・率を示し、相手が比べはじめた', NULL, 0, 3),
  ('proposed', '提案済み', 4, 4000, '企画書・見積・条件書を提出した', 'proposal', 0, 4),
  ('staff_agreed', '担当の合意', 5, 5000, '相手の担当者が進めたいと言った', NULL, 0, 5),
  ('approver_agreed', '決裁者の合意', 6, 6000, '相手の決裁者が進める方向と言った', NULL, 0, 6),
  ('terms_agreed', '条件の合意', 7, 7000, '予算・時期・配分を両者で合意した', NULL, 0, 7),
  ('informal_offer', '内示', 8, 8000, '相手が発注・出資・許諾の意思を示した', NULL, 0, 8),
  ('contract_drafting', '契約の調整', 9, 9000, '契約書を往復している・相手の社内で稟議中', NULL, 0, 9),
  ('contracted', '契約済み', 10, 10000, '契約書を受領した（成立）', 'contract', 0, 10);
CREATE TRIGGER earning_types_fixed BEFORE UPDATE OF project_type, profit_source, base_amount_kind, rate_source ON earning_types FOR EACH ROW EXECUTE FUNCTION lite_reject_change('earning type kind is fixed');
CREATE TRIGGER project_stages_fixed BEFORE UPDATE OF probability_bps, step_code, requires_reason ON project_stages FOR EACH ROW EXECUTE FUNCTION lite_reject_change('project stage kind is fixed');
ALTER TABLE projects ADD COLUMN project_type text COLLATE "C" CHECK (project_type IS NULL OR project_type IN ('field_contract', 'production', 'acquisition', 'agency', 'sw_contract', 'contract_production'));
ALTER TABLE projects ADD COLUMN earning_type text COLLATE "C";
ALTER TABLE projects ADD COLUMN base_amount_yen bigint CHECK (base_amount_yen IS NULL OR (lite_typeof(base_amount_yen) = 'integer' AND base_amount_yen BETWEEN 0 AND 9007199254740991));
ALTER TABLE projects ADD COLUMN revenue_rate_bps bigint CHECK (revenue_rate_bps IS NULL OR (lite_typeof(revenue_rate_bps) = 'integer' AND revenue_rate_bps BETWEEN 0 AND 10000));
ALTER TABLE projects ADD COLUMN counterparty_name text COLLATE "C" CHECK (counterparty_name IS NULL OR length(trim(counterparty_name)) BETWEEN 1 AND 200);
ALTER TABLE projects ADD COLUMN key_person text COLLATE "C" CHECK (key_person IS NULL OR length(trim(key_person)) BETWEEN 1 AND 200);
ALTER TABLE projects ADD COLUMN started_on text COLLATE "C" CHECK (started_on IS NULL OR (length(started_on) = 10 AND substr(started_on, 5, 1) = '-' AND substr(started_on, 8, 1) = '-' AND ltrim(substr(started_on, 1, 4) || substr(started_on, 6, 2) || substr(started_on, 9, 2), '0123456789') = '' AND substr(started_on, 6, 2) BETWEEN '01' AND '12' AND substr(started_on, 9, 2) BETWEEN '01' AND '31'));
ALTER TABLE projects ADD COLUMN planning_folder text COLLATE "C" CHECK (planning_folder IS NULL OR length(trim(planning_folder)) BETWEEN 1 AND 500);
ALTER TABLE projects ADD COLUMN note text COLLATE "C" CHECK (note IS NULL OR length(note) BETWEEN 1 AND 2000);
CREATE FUNCTION projects_earning_type_insert_fn() RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  IF (NEW.earning_type IS NOT NULL AND NOT EXISTS (SELECT 1 FROM earning_types e WHERE e.code = NEW.earning_type AND e.project_type = NEW.project_type)) IS NOT TRUE THEN RETURN NEW; END IF;
  RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'project earning type does not match project type';
  RETURN NEW;
END
$fn$;
CREATE TRIGGER projects_earning_type_insert BEFORE INSERT ON projects FOR EACH ROW EXECUTE FUNCTION projects_earning_type_insert_fn();
CREATE FUNCTION projects_revenue_rate_insert_fn() RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  IF (NEW.revenue_rate_bps IS NOT NULL AND (NEW.earning_type IS NULL OR EXISTS (SELECT 1 FROM earning_types e WHERE e.code = NEW.earning_type AND e.project_type = NEW.project_type AND e.rate_source <> 'project'))) IS NOT TRUE THEN RETURN NEW; END IF;
  RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'project revenue rate needs an earning type that uses it';
  RETURN NEW;
END
$fn$;
CREATE TRIGGER projects_revenue_rate_insert BEFORE INSERT ON projects FOR EACH ROW EXECUTE FUNCTION projects_revenue_rate_insert_fn();
CREATE FUNCTION projects_type_fixed_fn() RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  IF (OLD.project_type IS NOT NULL AND NEW.project_type IS DISTINCT FROM OLD.project_type) IS NOT TRUE THEN RETURN NEW; END IF;
  RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'project type is fixed after registration';
  RETURN NEW;
END
$fn$;
CREATE TRIGGER projects_type_fixed BEFORE UPDATE OF project_type, earning_type, revenue_rate_bps ON projects FOR EACH ROW EXECUTE FUNCTION projects_type_fixed_fn();
CREATE FUNCTION projects_sw_contract_has_no_works_fn() RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  IF ((OLD.project_type IS NULL OR NEW.project_type IS NOT DISTINCT FROM OLD.project_type) AND NEW.project_type = 'sw_contract' AND EXISTS (SELECT 1 FROM works w WHERE w.org_id = NEW.org_id AND w.project_id = NEW.id)) IS NOT TRUE THEN RETURN NEW; END IF;
  RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'software contract project cannot have works';
  RETURN NEW;
END
$fn$;
CREATE TRIGGER projects_sw_contract_has_no_works BEFORE UPDATE OF project_type, earning_type, revenue_rate_bps ON projects FOR EACH ROW EXECUTE FUNCTION projects_sw_contract_has_no_works_fn();
CREATE FUNCTION projects_earning_type_update_fn() RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  IF ((OLD.project_type IS NULL OR NEW.project_type IS NOT DISTINCT FROM OLD.project_type) AND (NEW.project_type IS DISTINCT FROM 'sw_contract' OR NOT EXISTS (SELECT 1 FROM works w WHERE w.org_id = NEW.org_id AND w.project_id = NEW.id)) AND NEW.earning_type IS NOT NULL AND NOT EXISTS (SELECT 1 FROM earning_types e WHERE e.code = NEW.earning_type AND e.project_type = NEW.project_type)) IS NOT TRUE THEN RETURN NEW; END IF;
  RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'project earning type does not match project type';
  RETURN NEW;
END
$fn$;
CREATE TRIGGER projects_earning_type_update BEFORE UPDATE OF project_type, earning_type, revenue_rate_bps ON projects FOR EACH ROW EXECUTE FUNCTION projects_earning_type_update_fn();
CREATE FUNCTION projects_revenue_rate_update_fn() RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  IF ((OLD.project_type IS NULL OR NEW.project_type IS NOT DISTINCT FROM OLD.project_type) AND (NEW.project_type IS DISTINCT FROM 'sw_contract' OR NOT EXISTS (SELECT 1 FROM works w WHERE w.org_id = NEW.org_id AND w.project_id = NEW.id)) AND NEW.revenue_rate_bps IS NOT NULL AND (NEW.earning_type IS NULL OR EXISTS (SELECT 1 FROM earning_types e WHERE e.code = NEW.earning_type AND e.project_type = NEW.project_type AND e.rate_source <> 'project'))) IS NOT TRUE THEN RETURN NEW; END IF;
  RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'project revenue rate needs an earning type that uses it';
  RETURN NEW;
END
$fn$;
CREATE TRIGGER projects_revenue_rate_update BEFORE UPDATE OF project_type, earning_type, revenue_rate_bps ON projects FOR EACH ROW EXECUTE FUNCTION projects_revenue_rate_update_fn();
CREATE FUNCTION works_not_under_sw_contract_insert_fn() RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  IF ((SELECT p.project_type FROM projects p WHERE p.org_id = NEW.org_id AND p.id = NEW.project_id) = 'sw_contract') IS NOT TRUE THEN RETURN NEW; END IF;
  RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'software contract project cannot have works';
  RETURN NEW;
END
$fn$;
CREATE TRIGGER works_not_under_sw_contract_insert BEFORE INSERT ON works FOR EACH ROW EXECUTE FUNCTION works_not_under_sw_contract_insert_fn();
CREATE FUNCTION works_not_under_sw_contract_update_fn() RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  IF ((SELECT p.project_type FROM projects p WHERE p.org_id = NEW.org_id AND p.id = NEW.project_id) = 'sw_contract') IS NOT TRUE THEN RETURN NEW; END IF;
  RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'software contract project cannot have works';
  RETURN NEW;
END
$fn$;
CREATE TRIGGER works_not_under_sw_contract_update BEFORE UPDATE OF project_id ON works FOR EACH ROW EXECUTE FUNCTION works_not_under_sw_contract_update_fn();
CREATE TABLE project_stage_events (
  id bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  org_id bigint NOT NULL,
  project_id bigint NOT NULL,
  seq bigint NOT NULL CHECK (seq > 0),
  stage_code text COLLATE "C" NOT NULL,
  previous_stage_code text COLLATE "C",
  entered_on text COLLATE "C" NOT NULL CHECK (length(entered_on) = 10 AND substr(entered_on, 5, 1) = '-' AND substr(entered_on, 8, 1) = '-' AND ltrim(substr(entered_on, 1, 4) || substr(entered_on, 6, 2) || substr(entered_on, 9, 2), '0123456789') = '' AND substr(entered_on, 6, 2) BETWEEN '01' AND '12' AND substr(entered_on, 9, 2) BETWEEN '01' AND '31'),
  evidence text COLLATE "C" CHECK (evidence IS NULL OR length(trim(evidence)) BETWEEN 1 AND 1000),
  reason text COLLATE "C" CHECK (reason IS NULL OR length(trim(reason)) BETWEEN 1 AND 1000),
  created_by bigint NOT NULL,
  created_at text COLLATE "C" NOT NULL DEFAULT to_char(statement_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS'),
  UNIQUE (org_id, project_id, seq),
  CHECK (previous_stage_code IS NULL OR previous_stage_code <> stage_code)
);
CREATE FUNCTION project_stage_events_stale_fn() RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  IF (NEW.seq <> (SELECT COALESCE(max(e.seq), 0) + 1 FROM project_stage_events e WHERE e.org_id = NEW.org_id AND e.project_id = NEW.project_id) OR NEW.previous_stage_code IS DISTINCT FROM (SELECT e.stage_code FROM project_stage_events e WHERE e.org_id = NEW.org_id AND e.project_id = NEW.project_id AND e.seq = NEW.seq - 1)) IS NOT TRUE THEN RETURN NEW; END IF;
  RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'stale project stage';
  RETURN NEW;
END
$fn$;
CREATE TRIGGER project_stage_events_stale BEFORE INSERT ON project_stage_events FOR EACH ROW EXECUTE FUNCTION project_stage_events_stale_fn();
CREATE FUNCTION project_stage_events_date_order_fn() RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  IF (NEW.seq = (SELECT COALESCE(max(e.seq), 0) + 1 FROM project_stage_events e WHERE e.org_id = NEW.org_id AND e.project_id = NEW.project_id) AND NEW.previous_stage_code IS NOT DISTINCT FROM (SELECT e.stage_code FROM project_stage_events e WHERE e.org_id = NEW.org_id AND e.project_id = NEW.project_id AND e.seq = NEW.seq - 1) AND EXISTS (SELECT 1 FROM project_stage_events e WHERE e.org_id = NEW.org_id AND e.project_id = NEW.project_id AND e.seq = NEW.seq - 1 AND e.entered_on > NEW.entered_on)) IS NOT TRUE THEN RETURN NEW; END IF;
  RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'project stage date goes back';
  RETURN NEW;
END
$fn$;
CREATE TRIGGER project_stage_events_date_order BEFORE INSERT ON project_stage_events FOR EACH ROW EXECUTE FUNCTION project_stage_events_date_order_fn();
CREATE FUNCTION project_stage_events_reason_fn() RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  IF (NEW.seq = (SELECT COALESCE(max(e.seq), 0) + 1 FROM project_stage_events e WHERE e.org_id = NEW.org_id AND e.project_id = NEW.project_id) AND NEW.previous_stage_code IS NOT DISTINCT FROM (SELECT e.stage_code FROM project_stage_events e WHERE e.org_id = NEW.org_id AND e.project_id = NEW.project_id AND e.seq = NEW.seq - 1) AND NOT EXISTS (SELECT 1 FROM project_stage_events e WHERE e.org_id = NEW.org_id AND e.project_id = NEW.project_id AND e.seq = NEW.seq - 1 AND e.entered_on > NEW.entered_on) AND NEW.reason IS NULL AND (SELECT s.requires_reason FROM project_stages s WHERE s.code = NEW.stage_code) = 1) IS NOT TRUE THEN RETURN NEW; END IF;
  RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'declined project stage needs a reason';
  RETURN NEW;
END
$fn$;
CREATE TRIGGER project_stage_events_reason BEFORE INSERT ON project_stage_events FOR EACH ROW EXECUTE FUNCTION project_stage_events_reason_fn();
CREATE TRIGGER project_stage_events_no_update BEFORE UPDATE ON project_stage_events FOR EACH ROW EXECUTE FUNCTION lite_reject_change('project stage history is append-only');
CREATE TRIGGER project_stage_events_no_delete BEFORE DELETE ON project_stage_events FOR EACH ROW EXECUTE FUNCTION lite_reject_change('project stage history is append-only');
CREATE TABLE earning_type_rate_versions (
  org_id bigint NOT NULL,
  earning_type text COLLATE "C" NOT NULL,
  version_no bigint NOT NULL CHECK (version_no > 0),
  revenue_rate_bps bigint NOT NULL CHECK (lite_typeof(revenue_rate_bps) = 'integer' AND revenue_rate_bps BETWEEN 0 AND 10000),
  status text COLLATE "C" NOT NULL CHECK (status IN ('confirmed', 'director_reported', 'press_reported', 'provisional')),
  basis text COLLATE "C" CHECK (basis IS NULL OR length(trim(basis)) BETWEEN 1 AND 1000),
  created_by bigint NOT NULL,
  created_at text COLLATE "C" NOT NULL DEFAULT to_char(statement_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS'),
  PRIMARY KEY (org_id, earning_type, version_no)
);
CREATE FUNCTION earning_type_rate_versions_sequence_fn() RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  IF (NEW.version_no <> (SELECT COALESCE(max(v.version_no), 0) + 1 FROM earning_type_rate_versions v WHERE v.org_id = NEW.org_id AND v.earning_type = NEW.earning_type)) IS NOT TRUE THEN RETURN NEW; END IF;
  RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'stale earning type rate version';
  RETURN NEW;
END
$fn$;
CREATE TRIGGER earning_type_rate_versions_sequence BEFORE INSERT ON earning_type_rate_versions FOR EACH ROW EXECUTE FUNCTION earning_type_rate_versions_sequence_fn();
CREATE FUNCTION earning_type_rate_versions_project_rate_only_fn() RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  IF (NEW.version_no = (SELECT COALESCE(max(v.version_no), 0) + 1 FROM earning_type_rate_versions v WHERE v.org_id = NEW.org_id AND v.earning_type = NEW.earning_type) AND (SELECT e.rate_source FROM earning_types e WHERE e.code = NEW.earning_type) <> 'project') IS NOT TRUE THEN RETURN NEW; END IF;
  RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'earning type uses the contract rate';
  RETURN NEW;
END
$fn$;
CREATE TRIGGER earning_type_rate_versions_project_rate_only BEFORE INSERT ON earning_type_rate_versions FOR EACH ROW EXECUTE FUNCTION earning_type_rate_versions_project_rate_only_fn();
CREATE TRIGGER earning_type_rate_versions_no_update BEFORE UPDATE ON earning_type_rate_versions FOR EACH ROW EXECUTE FUNCTION lite_reject_change('earning type rate version immutable');
CREATE TRIGGER earning_type_rate_versions_no_delete BEFORE DELETE ON earning_type_rate_versions FOR EACH ROW EXECUTE FUNCTION lite_reject_change('earning type rate version immutable');
CREATE TABLE cashflow_categories (
  id bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  org_id bigint NOT NULL,
  code text COLLATE "C" NOT NULL CHECK (length(code) BETWEEN 1 AND 40 AND ltrim(code, 'abcdefghijklmnopqrstuvwxyz0123456789_') = ''),
  label text COLLATE "C" NOT NULL CHECK (length(trim(label)) BETWEEN 1 AND 60),
  direction text COLLATE "C" NOT NULL CHECK (direction IN ('in', 'out')),
  counts_as_revenue bigint NOT NULL CHECK (counts_as_revenue IN (0, 1)),
  sort_order bigint NOT NULL DEFAULT 0 CHECK (sort_order >= 0),
  created_at text COLLATE "C" NOT NULL DEFAULT to_char(statement_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS'),
  UNIQUE (org_id, id),
  UNIQUE (org_id, code),
  UNIQUE (org_id, label),
  CHECK (direction = 'in' OR counts_as_revenue = 0)
);
CREATE TRIGGER cashflow_categories_fixed BEFORE UPDATE OF org_id, code, direction, counts_as_revenue ON cashflow_categories FOR EACH ROW EXECUTE FUNCTION lite_reject_change('cashflow category kind is fixed');

-- ===== 0013_contract_production_versions.sql =====
CREATE TABLE contract_production_versions (
  org_id bigint NOT NULL,
  project_id bigint NOT NULL,
  version_no bigint NOT NULL CHECK (lite_typeof(version_no) = 'integer' AND version_no > 0),
  budget_yen bigint NOT NULL CHECK (lite_typeof(budget_yen) = 'integer' AND budget_yen BETWEEN 1 AND 1000000000000),
  markup_bps bigint NOT NULL DEFAULT 1000 CHECK (lite_typeof(markup_bps) = 'integer' AND markup_bps BETWEEN 1000 AND 1500),
  fee_yen bigint NOT NULL CHECK (lite_typeof(fee_yen) = 'integer' AND fee_yen = budget_yen * markup_bps / 10000),
  milestone_count bigint NOT NULL CHECK (lite_typeof(milestone_count) = 'integer' AND milestone_count BETWEEN 1 AND 60),
  contract_reference text COLLATE "C" CHECK (contract_reference IS NULL OR length(trim(contract_reference)) BETWEEN 1 AND 500),
  note text COLLATE "C" CHECK (note IS NULL OR length(note) BETWEEN 1 AND 2000),
  created_by bigint NOT NULL,
  created_at text COLLATE "C" NOT NULL DEFAULT to_char(statement_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS'),
  PRIMARY KEY (org_id, project_id, version_no)
);
CREATE FUNCTION contract_production_versions_sequence_fn() RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  IF (NEW.version_no <> (SELECT COALESCE(max(v.version_no), 0) + 1 FROM contract_production_versions v WHERE v.org_id = NEW.org_id AND v.project_id = NEW.project_id)) IS NOT TRUE THEN RETURN NEW; END IF;
  RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'stale contract production version';
  RETURN NEW;
END
$fn$;
CREATE TRIGGER contract_production_versions_sequence BEFORE INSERT ON contract_production_versions FOR EACH ROW EXECUTE FUNCTION contract_production_versions_sequence_fn();
CREATE FUNCTION contract_production_versions_project_type_fn() RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  IF (NEW.version_no = (SELECT COALESCE(max(v.version_no), 0) + 1 FROM contract_production_versions v WHERE v.org_id = NEW.org_id AND v.project_id = NEW.project_id) AND EXISTS (SELECT 1 FROM projects p WHERE p.org_id = NEW.org_id AND p.id = NEW.project_id AND p.project_type IS DISTINCT FROM 'contract_production')) IS NOT TRUE THEN RETURN NEW; END IF;
  RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'contract production version needs a contract production project';
  RETURN NEW;
END
$fn$;
CREATE TRIGGER contract_production_versions_project_type BEFORE INSERT ON contract_production_versions FOR EACH ROW EXECUTE FUNCTION contract_production_versions_project_type_fn();
CREATE TRIGGER contract_production_versions_no_update BEFORE UPDATE ON contract_production_versions FOR EACH ROW EXECUTE FUNCTION lite_reject_change('contract production version is append-only');
CREATE TRIGGER contract_production_versions_no_delete BEFORE DELETE ON contract_production_versions FOR EACH ROW EXECUTE FUNCTION lite_reject_change('contract production version is append-only');
CREATE TABLE contract_production_milestones (
  org_id bigint NOT NULL,
  project_id bigint NOT NULL,
  version_no bigint NOT NULL,
  seq bigint NOT NULL CHECK (lite_typeof(seq) = 'integer' AND seq > 0),
  due_on text COLLATE "C" NOT NULL CHECK (length(due_on) = 10 AND substr(due_on, 5, 1) = '-' AND substr(due_on, 8, 1) = '-' AND ltrim(substr(due_on, 1, 4) || substr(due_on, 6, 2), '0123456789') = '' AND substr(due_on, 6, 2) BETWEEN '01' AND '12' AND substr(due_on, 9, 2) = '01'),
  share_bps bigint NOT NULL CHECK (lite_typeof(share_bps) = 'integer' AND share_bps BETWEEN 1 AND 10000),
  PRIMARY KEY (org_id, project_id, version_no, seq)
);
CREATE FUNCTION contract_production_milestones_order_fn() RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  IF (NEW.seq <> (SELECT COALESCE(max(m.seq), 0) + 1 FROM contract_production_milestones m WHERE m.org_id = NEW.org_id AND m.project_id = NEW.project_id AND m.version_no = NEW.version_no)) IS NOT TRUE THEN RETURN NEW; END IF;
  RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'contract milestone out of order';
  RETURN NEW;
END
$fn$;
CREATE TRIGGER contract_production_milestones_order BEFORE INSERT ON contract_production_milestones FOR EACH ROW EXECUTE FUNCTION contract_production_milestones_order_fn();
CREATE FUNCTION contract_production_milestones_count_fn() RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  IF (NEW.seq = (SELECT COALESCE(max(m.seq), 0) + 1 FROM contract_production_milestones m WHERE m.org_id = NEW.org_id AND m.project_id = NEW.project_id AND m.version_no = NEW.version_no) AND NEW.seq > (SELECT v.milestone_count FROM contract_production_versions v WHERE v.org_id = NEW.org_id AND v.project_id = NEW.project_id AND v.version_no = NEW.version_no)) IS NOT TRUE THEN RETURN NEW; END IF;
  RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'contract milestone beyond the count';
  RETURN NEW;
END
$fn$;
CREATE TRIGGER contract_production_milestones_count BEFORE INSERT ON contract_production_milestones FOR EACH ROW EXECUTE FUNCTION contract_production_milestones_count_fn();
CREATE FUNCTION contract_production_milestones_month_order_fn() RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  IF (NEW.seq = (SELECT COALESCE(max(m.seq), 0) + 1 FROM contract_production_milestones m WHERE m.org_id = NEW.org_id AND m.project_id = NEW.project_id AND m.version_no = NEW.version_no) AND NEW.seq <= (SELECT v.milestone_count FROM contract_production_versions v WHERE v.org_id = NEW.org_id AND v.project_id = NEW.project_id AND v.version_no = NEW.version_no) AND EXISTS (SELECT 1 FROM contract_production_milestones m WHERE m.org_id = NEW.org_id AND m.project_id = NEW.project_id AND m.version_no = NEW.version_no AND m.seq = NEW.seq - 1 AND m.due_on >= NEW.due_on)) IS NOT TRUE THEN RETURN NEW; END IF;
  RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'contract milestone month goes back';
  RETURN NEW;
END
$fn$;
CREATE TRIGGER contract_production_milestones_month_order BEFORE INSERT ON contract_production_milestones FOR EACH ROW EXECUTE FUNCTION contract_production_milestones_month_order_fn();
CREATE FUNCTION contract_production_milestones_share_total_fn() RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  IF (NEW.seq = (SELECT COALESCE(max(m.seq), 0) + 1 FROM contract_production_milestones m WHERE m.org_id = NEW.org_id AND m.project_id = NEW.project_id AND m.version_no = NEW.version_no) AND NEW.seq <= (SELECT v.milestone_count FROM contract_production_versions v WHERE v.org_id = NEW.org_id AND v.project_id = NEW.project_id AND v.version_no = NEW.version_no) AND NOT EXISTS (SELECT 1 FROM contract_production_milestones m WHERE m.org_id = NEW.org_id AND m.project_id = NEW.project_id AND m.version_no = NEW.version_no AND m.seq = NEW.seq - 1 AND m.due_on >= NEW.due_on) AND ((SELECT COALESCE(SUM(m.share_bps), 0) FROM contract_production_milestones m WHERE m.org_id = NEW.org_id AND m.project_id = NEW.project_id AND m.version_no = NEW.version_no) + NEW.share_bps > 10000 OR (NEW.seq = (SELECT v.milestone_count FROM contract_production_versions v WHERE v.org_id = NEW.org_id AND v.project_id = NEW.project_id AND v.version_no = NEW.version_no) AND (SELECT COALESCE(SUM(m.share_bps), 0) FROM contract_production_milestones m WHERE m.org_id = NEW.org_id AND m.project_id = NEW.project_id AND m.version_no = NEW.version_no) + NEW.share_bps <> 10000))) IS NOT TRUE THEN RETURN NEW; END IF;
  RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'contract milestone shares must total 10000';
  RETURN NEW;
END
$fn$;
CREATE TRIGGER contract_production_milestones_share_total BEFORE INSERT ON contract_production_milestones FOR EACH ROW EXECUTE FUNCTION contract_production_milestones_share_total_fn();
CREATE TRIGGER contract_production_milestones_no_update BEFORE UPDATE ON contract_production_milestones FOR EACH ROW EXECUTE FUNCTION lite_reject_change('contract production version is append-only');
CREATE TRIGGER contract_production_milestones_no_delete BEFORE DELETE ON contract_production_milestones FOR EACH ROW EXECUTE FUNCTION lite_reject_change('contract production version is append-only');

-- ===== 0014_yojitsu_targets_plans_settings.sql =====
CREATE TABLE yojitsu_periods (
  id bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  org_id bigint NOT NULL,
  year_no bigint NOT NULL CHECK (lite_typeof(year_no) = 'integer' AND year_no BETWEEN 1 AND 5),
  starts_on text COLLATE "C" NOT NULL CHECK (length(starts_on) = 10 AND substr(starts_on, 5, 1) = '-' AND substr(starts_on, 8, 1) = '-' AND ltrim(substr(starts_on, 1, 4) || substr(starts_on, 6, 2), '0123456789') = '' AND substr(starts_on, 6, 2) BETWEEN '01' AND '12' AND substr(starts_on, 9, 2) = '01'),
  created_by bigint NOT NULL,
  created_at text COLLATE "C" NOT NULL DEFAULT to_char(statement_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS'),
  UNIQUE (org_id, id),
  UNIQUE (org_id, year_no)
);
CREATE FUNCTION yojitsu_periods_order_fn() RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  IF (NEW.year_no <> (SELECT COALESCE(max(p.year_no), 0) + 1 FROM yojitsu_periods p WHERE p.org_id = NEW.org_id)) IS NOT TRUE THEN RETURN NEW; END IF;
  RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'yojitsu period out of order';
  RETURN NEW;
END
$fn$;
CREATE TRIGGER yojitsu_periods_order BEFORE INSERT ON yojitsu_periods FOR EACH ROW EXECUTE FUNCTION yojitsu_periods_order_fn();
CREATE FUNCTION yojitsu_periods_contiguous_fn() RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  IF (NEW.year_no = (SELECT COALESCE(max(p.year_no), 0) + 1 FROM yojitsu_periods p WHERE p.org_id = NEW.org_id) AND NEW.year_no > 1 AND NOT EXISTS (SELECT 1 FROM yojitsu_periods p WHERE p.org_id = NEW.org_id AND p.year_no = NEW.year_no - 1 AND substr(p.starts_on, 6, 5) = substr(NEW.starts_on, 6, 5) AND lite_cast_int(substr(p.starts_on, 1, 4)) + 1 = lite_cast_int(substr(NEW.starts_on, 1, 4)))) IS NOT TRUE THEN RETURN NEW; END IF;
  RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'yojitsu period must start 12 months after the previous';
  RETURN NEW;
END
$fn$;
CREATE TRIGGER yojitsu_periods_contiguous BEFORE INSERT ON yojitsu_periods FOR EACH ROW EXECUTE FUNCTION yojitsu_periods_contiguous_fn();
CREATE TRIGGER yojitsu_periods_no_update BEFORE UPDATE ON yojitsu_periods FOR EACH ROW EXECUTE FUNCTION lite_reject_change('yojitsu period is fixed');
CREATE TRIGGER yojitsu_periods_no_delete BEFORE DELETE ON yojitsu_periods FOR EACH ROW EXECUTE FUNCTION lite_reject_change('yojitsu period is fixed');
CREATE TABLE yojitsu_target_versions (
  id bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  org_id bigint NOT NULL,
  period_id bigint NOT NULL,
  target_kind text COLLATE "C" NOT NULL CHECK (target_kind IN ('self', 'company')),
  target_scope text COLLATE "C" NOT NULL CHECK (target_scope IN ('all', 'production_share')),
  version_no bigint NOT NULL CHECK (lite_typeof(version_no) = 'integer' AND version_no > 0),
  basis_kind text COLLATE "C" NOT NULL CHECK (basis_kind IN ('amount', 'labor_cost_multiple')),
  amount_yen bigint CHECK (amount_yen IS NULL OR (lite_typeof(amount_yen) = 'integer' AND amount_yen BETWEEN 0 AND 9007199254740991)),
  multiplier_x100 bigint CHECK (multiplier_x100 IS NULL OR (lite_typeof(multiplier_x100) = 'integer' AND multiplier_x100 BETWEEN 1 AND 10000)),
  source1_yen bigint CHECK (source1_yen IS NULL OR (lite_typeof(source1_yen) = 'integer' AND source1_yen BETWEEN 0 AND 9007199254740991)),
  source2_yen bigint CHECK (source2_yen IS NULL OR (lite_typeof(source2_yen) = 'integer' AND source2_yen BETWEEN 0 AND 9007199254740991)),
  source3_yen bigint CHECK (source3_yen IS NULL OR (lite_typeof(source3_yen) = 'integer' AND source3_yen BETWEEN 0 AND 9007199254740991)),
  source4_yen bigint CHECK (source4_yen IS NULL OR (lite_typeof(source4_yen) = 'integer' AND source4_yen BETWEEN 0 AND 9007199254740991)),
  source5_yen bigint CHECK (source5_yen IS NULL OR (lite_typeof(source5_yen) = 'integer' AND source5_yen BETWEEN 0 AND 9007199254740991)),
  unit text COLLATE "C" NOT NULL CHECK (unit IN ('period_total', 'monthly')),
  basis text COLLATE "C" CHECK (basis IS NULL OR length(trim(basis)) BETWEEN 1 AND 1000),
  status text COLLATE "C" NOT NULL CHECK (status IN ('confirmed', 'provisional')),
  decided_on text COLLATE "C" NOT NULL CHECK (length(decided_on) = 10 AND substr(decided_on, 5, 1) = '-' AND substr(decided_on, 8, 1) = '-' AND ltrim(substr(decided_on, 1, 4) || substr(decided_on, 6, 2) || substr(decided_on, 9, 2), '0123456789') = '' AND substr(decided_on, 6, 2) BETWEEN '01' AND '12' AND substr(decided_on, 9, 2) BETWEEN '01' AND '31'),
  decided_by text COLLATE "C" CHECK (decided_by IS NULL OR length(trim(decided_by)) BETWEEN 1 AND 200),
  owner_user_id bigint NOT NULL,
  created_by bigint NOT NULL,
  created_at text COLLATE "C" NOT NULL DEFAULT to_char(statement_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS'),
  UNIQUE (org_id, id),
  UNIQUE (org_id, period_id, target_kind, target_scope, version_no),
  CHECK ((basis_kind = 'amount' AND amount_yen IS NOT NULL AND multiplier_x100 IS NULL) OR (basis_kind = 'labor_cost_multiple' AND amount_yen IS NULL AND multiplier_x100 IS NOT NULL AND target_scope = 'all' AND unit = 'period_total')),
  CHECK (target_scope = 'all' OR (source1_yen IS NULL AND source2_yen IS NULL AND source3_yen IS NULL AND source4_yen IS NULL AND source5_yen IS NULL))
);
CREATE FUNCTION yojitsu_target_versions_sequence_fn() RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  IF (NEW.version_no <> (SELECT COALESCE(max(t.version_no), 0) + 1 FROM yojitsu_target_versions t WHERE t.org_id = NEW.org_id AND t.period_id = NEW.period_id AND t.target_kind = NEW.target_kind AND t.target_scope = NEW.target_scope)) IS NOT TRUE THEN RETURN NEW; END IF;
  RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'stale yojitsu target version';
  RETURN NEW;
END
$fn$;
CREATE TRIGGER yojitsu_target_versions_sequence BEFORE INSERT ON yojitsu_target_versions FOR EACH ROW EXECUTE FUNCTION yojitsu_target_versions_sequence_fn();
CREATE TRIGGER yojitsu_target_versions_no_update BEFORE UPDATE ON yojitsu_target_versions FOR EACH ROW EXECUTE FUNCTION lite_reject_change('yojitsu target version is append-only');
CREATE TRIGGER yojitsu_target_versions_no_delete BEFORE DELETE ON yojitsu_target_versions FOR EACH ROW EXECUTE FUNCTION lite_reject_change('yojitsu target version is append-only');
CREATE TABLE yojitsu_plan_versions (
  id bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  org_id bigint NOT NULL,
  period_id bigint NOT NULL,
  version_no bigint NOT NULL CHECK (lite_typeof(version_no) = 'integer' AND version_no > 0),
  owner_user_id bigint NOT NULL,
  earning_type_count bigint NOT NULL CHECK (lite_typeof(earning_type_count) = 'integer' AND earning_type_count BETWEEN 1 AND 20),
  status text COLLATE "C" NOT NULL CHECK (status IN ('confirmed', 'provisional')),
  basis text COLLATE "C" CHECK (basis IS NULL OR length(trim(basis)) BETWEEN 1 AND 1000),
  created_on text COLLATE "C" NOT NULL CHECK (length(created_on) = 10 AND substr(created_on, 5, 1) = '-' AND substr(created_on, 8, 1) = '-' AND ltrim(substr(created_on, 1, 4) || substr(created_on, 6, 2) || substr(created_on, 9, 2), '0123456789') = '' AND substr(created_on, 6, 2) BETWEEN '01' AND '12' AND substr(created_on, 9, 2) BETWEEN '01' AND '31'),
  created_by bigint NOT NULL,
  created_at text COLLATE "C" NOT NULL DEFAULT to_char(statement_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS'),
  UNIQUE (org_id, id),
  UNIQUE (org_id, period_id, id),
  UNIQUE (org_id, period_id, version_no)
);
CREATE FUNCTION yojitsu_plan_versions_sequence_fn() RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  IF (NEW.version_no <> (SELECT COALESCE(max(v.version_no), 0) + 1 FROM yojitsu_plan_versions v WHERE v.org_id = NEW.org_id AND v.period_id = NEW.period_id)) IS NOT TRUE THEN RETURN NEW; END IF;
  RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'stale yojitsu plan version';
  RETURN NEW;
END
$fn$;
CREATE TRIGGER yojitsu_plan_versions_sequence BEFORE INSERT ON yojitsu_plan_versions FOR EACH ROW EXECUTE FUNCTION yojitsu_plan_versions_sequence_fn();
CREATE TRIGGER yojitsu_plan_versions_no_update BEFORE UPDATE ON yojitsu_plan_versions FOR EACH ROW EXECUTE FUNCTION lite_reject_change('yojitsu plan version is append-only');
CREATE TRIGGER yojitsu_plan_versions_no_delete BEFORE DELETE ON yojitsu_plan_versions FOR EACH ROW EXECUTE FUNCTION lite_reject_change('yojitsu plan version is append-only');
CREATE TABLE yojitsu_plan_amounts (
  org_id bigint NOT NULL,
  plan_version_id bigint NOT NULL,
  earning_type text COLLATE "C" NOT NULL,
  amount_yen bigint NOT NULL CHECK (lite_typeof(amount_yen) = 'integer' AND amount_yen BETWEEN 0 AND 9007199254740991),
  PRIMARY KEY (org_id, plan_version_id, earning_type)
);
CREATE FUNCTION yojitsu_plan_amounts_count_fn() RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  IF ((SELECT COUNT(*) FROM yojitsu_plan_amounts a WHERE a.org_id = NEW.org_id AND a.plan_version_id = NEW.plan_version_id) >= (SELECT v.earning_type_count FROM yojitsu_plan_versions v WHERE v.org_id = NEW.org_id AND v.id = NEW.plan_version_id)) IS NOT TRUE THEN RETURN NEW; END IF;
  RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'yojitsu plan amount beyond the count';
  RETURN NEW;
END
$fn$;
CREATE TRIGGER yojitsu_plan_amounts_count BEFORE INSERT ON yojitsu_plan_amounts FOR EACH ROW EXECUTE FUNCTION yojitsu_plan_amounts_count_fn();
CREATE TRIGGER yojitsu_plan_amounts_no_update BEFORE UPDATE ON yojitsu_plan_amounts FOR EACH ROW EXECUTE FUNCTION lite_reject_change('yojitsu plan version is append-only');
CREATE TRIGGER yojitsu_plan_amounts_no_delete BEFORE DELETE ON yojitsu_plan_amounts FOR EACH ROW EXECUTE FUNCTION lite_reject_change('yojitsu plan version is append-only');
CREATE TABLE plan_adoptions (
  id bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  org_id bigint NOT NULL,
  period_id bigint NOT NULL,
  seq bigint NOT NULL CHECK (lite_typeof(seq) = 'integer' AND seq > 0),
  plan_version_id bigint NOT NULL,
  adopted_on text COLLATE "C" NOT NULL CHECK (length(adopted_on) = 10 AND substr(adopted_on, 5, 1) = '-' AND substr(adopted_on, 8, 1) = '-' AND ltrim(substr(adopted_on, 1, 4) || substr(adopted_on, 6, 2) || substr(adopted_on, 9, 2), '0123456789') = '' AND substr(adopted_on, 6, 2) BETWEEN '01' AND '12' AND substr(adopted_on, 9, 2) BETWEEN '01' AND '31'),
  created_by bigint NOT NULL,
  created_at text COLLATE "C" NOT NULL DEFAULT to_char(statement_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS'),
  UNIQUE (org_id, id),
  UNIQUE (org_id, period_id, seq)
);
CREATE FUNCTION plan_adoptions_sequence_fn() RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  IF (NEW.seq <> (SELECT COALESCE(max(a.seq), 0) + 1 FROM plan_adoptions a WHERE a.org_id = NEW.org_id AND a.period_id = NEW.period_id)) IS NOT TRUE THEN RETURN NEW; END IF;
  RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'stale plan adoption';
  RETURN NEW;
END
$fn$;
CREATE TRIGGER plan_adoptions_sequence BEFORE INSERT ON plan_adoptions FOR EACH ROW EXECUTE FUNCTION plan_adoptions_sequence_fn();
CREATE FUNCTION plan_adoptions_complete_version_fn() RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  IF (NEW.seq = (SELECT COALESCE(max(a.seq), 0) + 1 FROM plan_adoptions a WHERE a.org_id = NEW.org_id AND a.period_id = NEW.period_id) AND EXISTS (SELECT 1 FROM yojitsu_plan_versions v WHERE v.org_id = NEW.org_id AND v.id = NEW.plan_version_id AND v.earning_type_count <> (SELECT COUNT(*) FROM yojitsu_plan_amounts m WHERE m.org_id = v.org_id AND m.plan_version_id = v.id))) IS NOT TRUE THEN RETURN NEW; END IF;
  RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'plan version is incomplete';
  RETURN NEW;
END
$fn$;
CREATE TRIGGER plan_adoptions_complete_version BEFORE INSERT ON plan_adoptions FOR EACH ROW EXECUTE FUNCTION plan_adoptions_complete_version_fn();
CREATE FUNCTION plan_adoptions_date_order_fn() RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  IF (NEW.seq = (SELECT COALESCE(max(a.seq), 0) + 1 FROM plan_adoptions a WHERE a.org_id = NEW.org_id AND a.period_id = NEW.period_id) AND NOT EXISTS (SELECT 1 FROM yojitsu_plan_versions v WHERE v.org_id = NEW.org_id AND v.id = NEW.plan_version_id AND v.earning_type_count <> (SELECT COUNT(*) FROM yojitsu_plan_amounts m WHERE m.org_id = v.org_id AND m.plan_version_id = v.id)) AND EXISTS (SELECT 1 FROM plan_adoptions a WHERE a.org_id = NEW.org_id AND a.period_id = NEW.period_id AND a.seq = NEW.seq - 1 AND a.adopted_on > NEW.adopted_on)) IS NOT TRUE THEN RETURN NEW; END IF;
  RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'plan adoption date goes back';
  RETURN NEW;
END
$fn$;
CREATE TRIGGER plan_adoptions_date_order BEFORE INSERT ON plan_adoptions FOR EACH ROW EXECUTE FUNCTION plan_adoptions_date_order_fn();
CREATE TRIGGER plan_adoptions_no_update BEFORE UPDATE ON plan_adoptions FOR EACH ROW EXECUTE FUNCTION lite_reject_change('plan adoption is append-only');
CREATE TRIGGER plan_adoptions_no_delete BEFORE DELETE ON plan_adoptions FOR EACH ROW EXECUTE FUNCTION lite_reject_change('plan adoption is append-only');
CREATE TABLE yojitsu_variables (
  code text COLLATE "C" PRIMARY KEY CHECK (length(code) BETWEEN 1 AND 60 AND ltrim(code, 'abcdefghijklmnopqrstuvwxyz0123456789_') = ''),
  label text COLLATE "C" NOT NULL UNIQUE CHECK (length(trim(label)) BETWEEN 1 AND 60),
  value_kind text COLLATE "C" NOT NULL CHECK (value_kind IN ('bps', 'x100', 'months', 'yen')),
  per_step bigint NOT NULL CHECK (per_step IN (0, 1)),
  sort_order bigint NOT NULL UNIQUE CHECK (sort_order >= 0)
);
INSERT INTO yojitsu_variables (code, label, value_kind, per_step, sort_order) VALUES
  ('unit_amount', '1件あたりの額', 'yen', 0, 1),
  ('conversion_rate', '次の段へ進む率', 'bps', 1, 2),
  ('landing_probability', '着地に数える確度', 'bps', 0, 3),
  ('payment_lag', '窓口の支払いの間', 'months', 0, 4);
CREATE TRIGGER yojitsu_variables_fixed BEFORE UPDATE OF value_kind, per_step ON yojitsu_variables FOR EACH ROW EXECUTE FUNCTION lite_reject_change('yojitsu variable kind is fixed');
CREATE TABLE yojitsu_setting_versions (
  id bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  org_id bigint NOT NULL,
  variable_key text COLLATE "C" NOT NULL,
  scope text COLLATE "C" NOT NULL CHECK (scope IN ('all', 'earning_type', 'earning_type_step', 'project', 'channel')),
  earning_type text COLLATE "C",
  step text COLLATE "C",
  project_id bigint,
  channel_code text COLLATE "C" CHECK (channel_code IS NULL OR (length(channel_code) BETWEEN 1 AND 60 AND length(trim(channel_code)) = length(channel_code))),
  version_no bigint NOT NULL CHECK (lite_typeof(version_no) = 'integer' AND version_no > 0),
  value_bps bigint CHECK (value_bps IS NULL OR (lite_typeof(value_bps) = 'integer' AND value_bps BETWEEN 0 AND 10000)),
  value_x100 bigint CHECK (value_x100 IS NULL OR (lite_typeof(value_x100) = 'integer' AND value_x100 BETWEEN 0 AND 9007199254740991)),
  value_months bigint CHECK (value_months IS NULL OR (lite_typeof(value_months) = 'integer' AND value_months BETWEEN 0 AND 120)),
  value_yen bigint CHECK (value_yen IS NULL OR (lite_typeof(value_yen) = 'integer' AND value_yen BETWEEN 0 AND 9007199254740991)),
  status text COLLATE "C" NOT NULL CHECK (status IN ('confirmed', 'director_reported', 'press_reported', 'provisional')),
  basis text COLLATE "C" CHECK (basis IS NULL OR length(trim(basis)) BETWEEN 1 AND 1000),
  created_by bigint NOT NULL,
  created_at text COLLATE "C" NOT NULL DEFAULT to_char(statement_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS'),
  UNIQUE (org_id, id),
  CHECK ((scope = 'all' AND earning_type IS NULL AND step IS NULL AND project_id IS NULL AND channel_code IS NULL) OR (scope = 'earning_type' AND earning_type IS NOT NULL AND step IS NULL AND project_id IS NULL AND channel_code IS NULL) OR (scope = 'earning_type_step' AND earning_type IS NOT NULL AND step IS NOT NULL AND project_id IS NULL AND channel_code IS NULL) OR (scope = 'project' AND earning_type IS NULL AND step IS NULL AND project_id IS NOT NULL AND channel_code IS NULL) OR (scope = 'channel' AND earning_type IS NULL AND step IS NULL AND project_id IS NULL AND channel_code IS NOT NULL)),
  CHECK ((value_bps IS NOT NULL AND value_x100 IS NULL AND value_months IS NULL AND value_yen IS NULL) OR (value_bps IS NULL AND value_x100 IS NOT NULL AND value_months IS NULL AND value_yen IS NULL) OR (value_bps IS NULL AND value_x100 IS NULL AND value_months IS NOT NULL AND value_yen IS NULL) OR (value_bps IS NULL AND value_x100 IS NULL AND value_months IS NULL AND value_yen IS NOT NULL))
);
CREATE UNIQUE INDEX yojitsu_setting_versions_slot ON yojitsu_setting_versions (org_id, variable_key, scope, (coalesce(earning_type, '')), (coalesce(step, '')), (coalesce(project_id, 0)), (coalesce(channel_code, '')), version_no);
CREATE FUNCTION yojitsu_setting_versions_sequence_fn() RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  IF (NEW.version_no <> (SELECT COALESCE(max(s.version_no), 0) + 1 FROM yojitsu_setting_versions s WHERE s.org_id = NEW.org_id AND s.variable_key = NEW.variable_key AND s.scope = NEW.scope AND s.earning_type IS NOT DISTINCT FROM NEW.earning_type AND s.step IS NOT DISTINCT FROM NEW.step AND s.project_id IS NOT DISTINCT FROM NEW.project_id AND s.channel_code IS NOT DISTINCT FROM NEW.channel_code)) IS NOT TRUE THEN RETURN NEW; END IF;
  RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'stale yojitsu setting version';
  RETURN NEW;
END
$fn$;
CREATE TRIGGER yojitsu_setting_versions_sequence BEFORE INSERT ON yojitsu_setting_versions FOR EACH ROW EXECUTE FUNCTION yojitsu_setting_versions_sequence_fn();
CREATE FUNCTION yojitsu_setting_versions_value_kind_fn() RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  IF (NEW.version_no = (SELECT COALESCE(max(s.version_no), 0) + 1 FROM yojitsu_setting_versions s WHERE s.org_id = NEW.org_id AND s.variable_key = NEW.variable_key AND s.scope = NEW.scope AND s.earning_type IS NOT DISTINCT FROM NEW.earning_type AND s.step IS NOT DISTINCT FROM NEW.step AND s.project_id IS NOT DISTINCT FROM NEW.project_id AND s.channel_code IS NOT DISTINCT FROM NEW.channel_code) AND EXISTS (SELECT 1 FROM yojitsu_variables v WHERE v.code = NEW.variable_key AND NOT ((v.value_kind = 'bps' AND NEW.value_bps IS NOT NULL) OR (v.value_kind = 'x100' AND NEW.value_x100 IS NOT NULL) OR (v.value_kind = 'months' AND NEW.value_months IS NOT NULL) OR (v.value_kind = 'yen' AND NEW.value_yen IS NOT NULL)))) IS NOT TRUE THEN RETURN NEW; END IF;
  RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'yojitsu setting value does not match the variable';
  RETURN NEW;
END
$fn$;
CREATE TRIGGER yojitsu_setting_versions_value_kind BEFORE INSERT ON yojitsu_setting_versions FOR EACH ROW EXECUTE FUNCTION yojitsu_setting_versions_value_kind_fn();
CREATE FUNCTION yojitsu_setting_versions_step_scope_fn() RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  IF (NEW.version_no = (SELECT COALESCE(max(s.version_no), 0) + 1 FROM yojitsu_setting_versions s WHERE s.org_id = NEW.org_id AND s.variable_key = NEW.variable_key AND s.scope = NEW.scope AND s.earning_type IS NOT DISTINCT FROM NEW.earning_type AND s.step IS NOT DISTINCT FROM NEW.step AND s.project_id IS NOT DISTINCT FROM NEW.project_id AND s.channel_code IS NOT DISTINCT FROM NEW.channel_code) AND NOT EXISTS (SELECT 1 FROM yojitsu_variables v WHERE v.code = NEW.variable_key AND NOT ((v.value_kind = 'bps' AND NEW.value_bps IS NOT NULL) OR (v.value_kind = 'x100' AND NEW.value_x100 IS NOT NULL) OR (v.value_kind = 'months' AND NEW.value_months IS NOT NULL) OR (v.value_kind = 'yen' AND NEW.value_yen IS NOT NULL))) AND EXISTS (SELECT 1 FROM yojitsu_variables v WHERE v.code = NEW.variable_key AND ((v.per_step = 1 AND NEW.scope <> 'earning_type_step') OR (v.per_step = 0 AND NEW.scope = 'earning_type_step')))) IS NOT TRUE THEN RETURN NEW; END IF;
  RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'yojitsu setting scope does not match the variable';
  RETURN NEW;
END
$fn$;
CREATE TRIGGER yojitsu_setting_versions_step_scope BEFORE INSERT ON yojitsu_setting_versions FOR EACH ROW EXECUTE FUNCTION yojitsu_setting_versions_step_scope_fn();
CREATE TRIGGER yojitsu_setting_versions_no_update BEFORE UPDATE ON yojitsu_setting_versions FOR EACH ROW EXECUTE FUNCTION lite_reject_change('yojitsu setting version is append-only');
CREATE TRIGGER yojitsu_setting_versions_no_delete BEFORE DELETE ON yojitsu_setting_versions FOR EACH ROW EXECUTE FUNCTION lite_reject_change('yojitsu setting version is append-only');

-- ===== 0015_yojitsu_forecasts_activities.sql =====
CREATE TABLE yojitsu_forecast_versions (
  id bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  org_id bigint NOT NULL,
  project_id bigint NOT NULL,
  version_no bigint NOT NULL CHECK (lite_typeof(version_no) = 'integer' AND version_no > 0),
  label text COLLATE "C" NOT NULL CHECK (length(trim(label)) BETWEEN 1 AND 100),
  source_kind text COLLATE "C" NOT NULL CHECK (source_kind IN ('trial_import', 'manual', 'initiative')),
  source text COLLATE "C" NOT NULL CHECK (length(trim(source)) BETWEEN 1 AND 1000),
  source_sha256 text COLLATE "C" CHECK (source_sha256 IS NULL OR (length(source_sha256) = 64 AND ltrim(source_sha256, '0123456789abcdef') = '')),
  line_count bigint NOT NULL CHECK (lite_typeof(line_count) = 'integer' AND line_count BETWEEN 1 AND 3824),
  created_on text COLLATE "C" NOT NULL CHECK (length(created_on) = 10 AND substr(created_on, 5, 1) = '-' AND substr(created_on, 8, 1) = '-' AND ltrim(substr(created_on, 1, 4) || substr(created_on, 6, 2) || substr(created_on, 9, 2), '0123456789') = '' AND substr(created_on, 6, 2) BETWEEN '01' AND '12' AND substr(created_on, 9, 2) BETWEEN '01' AND '31'),
  created_by bigint NOT NULL,
  created_at text COLLATE "C" NOT NULL DEFAULT to_char(statement_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS'),
  UNIQUE (org_id, id),
  UNIQUE (org_id, project_id, version_no),
  CHECK ((source_kind = 'trial_import' AND source_sha256 IS NOT NULL) OR (source_kind <> 'trial_import' AND source_sha256 IS NULL))
);
CREATE FUNCTION yojitsu_forecast_versions_sequence_fn() RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  IF (NEW.version_no <> (SELECT COALESCE(max(v.version_no), 0) + 1 FROM yojitsu_forecast_versions v WHERE v.org_id = NEW.org_id AND v.project_id = NEW.project_id)) IS NOT TRUE THEN RETURN NEW; END IF;
  RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'stale yojitsu forecast version';
  RETURN NEW;
END
$fn$;
CREATE TRIGGER yojitsu_forecast_versions_sequence BEFORE INSERT ON yojitsu_forecast_versions FOR EACH ROW EXECUTE FUNCTION yojitsu_forecast_versions_sequence_fn();
CREATE TRIGGER yojitsu_forecast_versions_no_update BEFORE UPDATE ON yojitsu_forecast_versions FOR EACH ROW EXECUTE FUNCTION lite_reject_change('yojitsu forecast version is append-only');
CREATE TRIGGER yojitsu_forecast_versions_no_delete BEFORE DELETE ON yojitsu_forecast_versions FOR EACH ROW EXECUTE FUNCTION lite_reject_change('yojitsu forecast version is append-only');
CREATE TABLE yojitsu_forecast_lines (
  org_id bigint NOT NULL,
  project_id bigint NOT NULL,
  version_no bigint NOT NULL,
  line_no bigint NOT NULL CHECK (lite_typeof(line_no) = 'integer' AND line_no > 0),
  scenario text COLLATE "C" NOT NULL CHECK (scenario IN ('even', 'good', 'max', 'single')),
  forecast_month text COLLATE "C" NOT NULL CHECK (length(forecast_month) = 10 AND substr(forecast_month, 5, 1) = '-' AND substr(forecast_month, 8, 1) = '-' AND ltrim(substr(forecast_month, 1, 4) || substr(forecast_month, 6, 2), '0123456789') = '' AND substr(forecast_month, 6, 2) BETWEEN '01' AND '12' AND substr(forecast_month, 9, 2) = '01'),
  category_id bigint NOT NULL,
  item text COLLATE "C" NOT NULL CHECK (length(trim(item)) BETWEEN 1 AND 200),
  counterparty text COLLATE "C" CHECK (counterparty IS NULL OR length(trim(counterparty)) BETWEEN 1 AND 200),
  amount_yen bigint NOT NULL CHECK (lite_typeof(amount_yen) = 'integer' AND amount_yen BETWEEN 1 AND 9007199254740991),
  status text COLLATE "C" NOT NULL CHECK (status IN ('confirmed', 'director_reported', 'press_reported', 'provisional')),
  use_for_forecast bigint NOT NULL CHECK (use_for_forecast IN (0, 1)),
  PRIMARY KEY (org_id, project_id, version_no, line_no)
);
CREATE FUNCTION yojitsu_forecast_lines_within_count_fn() RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  IF (NEW.line_no > (SELECT v.line_count FROM yojitsu_forecast_versions v WHERE v.org_id = NEW.org_id AND v.project_id = NEW.project_id AND v.version_no = NEW.version_no)) IS NOT TRUE THEN RETURN NEW; END IF;
  RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'yojitsu forecast line beyond the count';
  RETURN NEW;
END
$fn$;
CREATE TRIGGER yojitsu_forecast_lines_within_count BEFORE INSERT ON yojitsu_forecast_lines FOR EACH ROW EXECUTE FUNCTION yojitsu_forecast_lines_within_count_fn();
CREATE FUNCTION yojitsu_forecast_lines_in_order_fn() RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  IF (NEW.line_no <> (SELECT COALESCE(max(l.line_no), 0) + 1 FROM yojitsu_forecast_lines l WHERE l.org_id = NEW.org_id AND l.project_id = NEW.project_id AND l.version_no = NEW.version_no)) IS NOT TRUE THEN RETURN NEW; END IF;
  RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'yojitsu forecast line out of order';
  RETURN NEW;
END
$fn$;
CREATE TRIGGER yojitsu_forecast_lines_in_order BEFORE INSERT ON yojitsu_forecast_lines FOR EACH ROW EXECUTE FUNCTION yojitsu_forecast_lines_in_order_fn();
CREATE TRIGGER yojitsu_forecast_lines_no_update BEFORE UPDATE ON yojitsu_forecast_lines FOR EACH ROW EXECUTE FUNCTION lite_reject_change('yojitsu forecast version is append-only');
CREATE TRIGGER yojitsu_forecast_lines_no_delete BEFORE DELETE ON yojitsu_forecast_lines FOR EACH ROW EXECUTE FUNCTION lite_reject_change('yojitsu forecast version is append-only');
CREATE TABLE yojitsu_activity_records (
  id bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  org_id bigint NOT NULL,
  project_id bigint NOT NULL,
  occurred_on text COLLATE "C" NOT NULL CHECK (length(occurred_on) = 10 AND substr(occurred_on, 5, 1) = '-' AND substr(occurred_on, 8, 1) = '-' AND ltrim(substr(occurred_on, 1, 4) || substr(occurred_on, 6, 2) || substr(occurred_on, 9, 2), '0123456789') = '' AND substr(occurred_on, 6, 2) BETWEEN '01' AND '12' AND substr(occurred_on, 9, 2) BETWEEN '01' AND '31'),
  earning_type text COLLATE "C",
  step text COLLATE "C",
  counterparty text COLLATE "C" CHECK (counterparty IS NULL OR length(trim(counterparty)) BETWEEN 1 AND 200),
  summary text COLLATE "C" NOT NULL CHECK (length(trim(summary)) BETWEEN 1 AND 1000),
  deliverable text COLLATE "C" CHECK (deliverable IS NULL OR length(trim(deliverable)) BETWEEN 1 AND 1000),
  next_action text COLLATE "C" CHECK (next_action IS NULL OR length(trim(next_action)) BETWEEN 1 AND 1000),
  next_due_on text COLLATE "C" CHECK (next_due_on IS NULL OR (length(next_due_on) = 10 AND substr(next_due_on, 5, 1) = '-' AND substr(next_due_on, 8, 1) = '-' AND ltrim(substr(next_due_on, 1, 4) || substr(next_due_on, 6, 2) || substr(next_due_on, 9, 2), '0123456789') = '' AND substr(next_due_on, 6, 2) BETWEEN '01' AND '12' AND substr(next_due_on, 9, 2) BETWEEN '01' AND '31')),
  result text COLLATE "C" NOT NULL CHECK (result IN ('advanced', 'on_hold', 'lost')),
  work_id bigint,
  source_sales_activity_id bigint,
  created_by bigint NOT NULL,
  created_at text COLLATE "C" NOT NULL DEFAULT to_char(statement_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS'),
  UNIQUE (org_id, id),
  UNIQUE (org_id, source_sales_activity_id),
  CHECK (next_due_on IS NULL OR next_action IS NOT NULL)
);
CREATE INDEX yojitsu_activity_records_project ON yojitsu_activity_records (org_id, project_id, occurred_on);
CREATE FUNCTION yojitsu_activity_records_source_match_fn() RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  IF (NEW.source_sales_activity_id IS NOT NULL AND EXISTS (SELECT 1 FROM sales_activities s WHERE s.org_id = NEW.org_id AND s.id = NEW.source_sales_activity_id AND (s.project_id <> NEW.project_id OR s.work_id IS DISTINCT FROM NEW.work_id))) IS NOT TRUE THEN RETURN NEW; END IF;
  RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'activity record does not match the sales activity';
  RETURN NEW;
END
$fn$;
CREATE TRIGGER yojitsu_activity_records_source_match BEFORE INSERT ON yojitsu_activity_records FOR EACH ROW EXECUTE FUNCTION yojitsu_activity_records_source_match_fn();
CREATE TRIGGER yojitsu_activity_records_no_update BEFORE UPDATE ON yojitsu_activity_records FOR EACH ROW EXECUTE FUNCTION lite_reject_change('activity record is append-only');
CREATE TRIGGER yojitsu_activity_records_no_delete BEFORE DELETE ON yojitsu_activity_records FOR EACH ROW EXECUTE FUNCTION lite_reject_change('activity record is append-only');
CREATE TABLE yojitsu_activity_cancellations (
  org_id bigint NOT NULL,
  activity_id bigint NOT NULL,
  cancelled_on text COLLATE "C" NOT NULL CHECK (length(cancelled_on) = 10 AND substr(cancelled_on, 5, 1) = '-' AND substr(cancelled_on, 8, 1) = '-' AND ltrim(substr(cancelled_on, 1, 4) || substr(cancelled_on, 6, 2) || substr(cancelled_on, 9, 2), '0123456789') = '' AND substr(cancelled_on, 6, 2) BETWEEN '01' AND '12' AND substr(cancelled_on, 9, 2) BETWEEN '01' AND '31'),
  reason text COLLATE "C" NOT NULL CHECK (length(trim(reason)) BETWEEN 1 AND 1000),
  created_by bigint NOT NULL,
  created_at text COLLATE "C" NOT NULL DEFAULT to_char(statement_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS'),
  PRIMARY KEY (org_id, activity_id)
);
CREATE FUNCTION yojitsu_activity_cancellations_recorder_only_fn() RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  IF (EXISTS (SELECT 1 FROM yojitsu_activity_records a WHERE a.org_id = NEW.org_id AND a.id = NEW.activity_id AND a.created_by <> NEW.created_by)) IS NOT TRUE THEN RETURN NEW; END IF;
  RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'only the recorder can cancel an activity record';
  RETURN NEW;
END
$fn$;
CREATE TRIGGER yojitsu_activity_cancellations_recorder_only BEFORE INSERT ON yojitsu_activity_cancellations FOR EACH ROW EXECUTE FUNCTION yojitsu_activity_cancellations_recorder_only_fn();
CREATE TRIGGER yojitsu_activity_cancellations_no_update BEFORE UPDATE ON yojitsu_activity_cancellations FOR EACH ROW EXECUTE FUNCTION lite_reject_change('activity cancellation is append-only');
CREATE TRIGGER yojitsu_activity_cancellations_no_delete BEFORE DELETE ON yojitsu_activity_cancellations FOR EACH ROW EXECUTE FUNCTION lite_reject_change('activity cancellation is append-only');

-- ===== 0016_production_cost_versions.sql =====
CREATE TABLE production_cost_versions (
  org_id bigint NOT NULL,
  work_id bigint NOT NULL,
  version_no bigint NOT NULL CHECK (lite_typeof(version_no) = 'integer' AND version_no > 0),
  source_kind text COLLATE "C" NOT NULL CHECK (source_kind IN ('investment', 'contract', 'additional_contract')),
  amount_yen bigint NOT NULL CHECK (lite_typeof(amount_yen) = 'integer' AND amount_yen BETWEEN 1 AND 1000000000000),
  tax_basis text COLLATE "C" NOT NULL CHECK (tax_basis IN ('ex_tax', 'unknown')),
  production_part_yen bigint CHECK (production_part_yen IS NULL OR (lite_typeof(production_part_yen) = 'integer' AND production_part_yen BETWEEN 0 AND 1000000000000)),
  pa_part_yen bigint CHECK (pa_part_yen IS NULL OR (lite_typeof(pa_part_yen) = 'integer' AND pa_part_yen BETWEEN 0 AND 1000000000000)),
  work_finance_revision bigint,
  committee_term_version_id bigint,
  contract_reference text COLLATE "C" CHECK (contract_reference IS NULL OR length(trim(contract_reference)) BETWEEN 1 AND 500),
  contract_signed_on text COLLATE "C" CHECK (contract_signed_on IS NULL OR (length(contract_signed_on) = 10 AND substr(contract_signed_on, 5, 1) = '-' AND substr(contract_signed_on, 8, 1) = '-' AND ltrim(substr(contract_signed_on, 1, 4) || substr(contract_signed_on, 6, 2) || substr(contract_signed_on, 9, 2), '0123456789') = '' AND substr(contract_signed_on, 6, 2) BETWEEN '01' AND '12' AND substr(contract_signed_on, 9, 2) BETWEEN '01' AND '31')),
  counterparty_partner_id bigint,
  contract_amount_yen bigint CHECK (contract_amount_yen IS NULL OR (lite_typeof(contract_amount_yen) = 'integer' AND contract_amount_yen BETWEEN 1 AND 1000000000000)),
  contract_tax_basis text COLLATE "C" CHECK (contract_tax_basis IS NULL OR contract_tax_basis IN ('ex_tax', 'inc_tax')),
  tax_conversion text COLLATE "C" CHECK (tax_conversion IS NULL OR length(trim(tax_conversion)) BETWEEN 1 AND 500),
  added_yen bigint CHECK (added_yen IS NULL OR (lite_typeof(added_yen) = 'integer' AND added_yen BETWEEN 1 AND 1000000000000)),
  burden_type text COLLATE "C" CHECK (burden_type IS NULL OR burden_type IN ('investor_additional', 'borrowing')),
  note text COLLATE "C" CHECK (note IS NULL OR length(trim(note)) BETWEEN 1 AND 1000),
  created_by bigint NOT NULL,
  created_at text COLLATE "C" NOT NULL DEFAULT to_char(statement_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS'),
  PRIMARY KEY (org_id, work_id, version_no),
  CHECK ((production_part_yen IS NULL AND pa_part_yen IS NULL) OR (production_part_yen IS NOT NULL AND pa_part_yen IS NOT NULL AND production_part_yen + pa_part_yen = amount_yen)),
  CHECK ((contract_tax_basis IS NULL AND tax_conversion IS NULL) OR (contract_tax_basis = 'ex_tax' AND tax_conversion IS NULL) OR (contract_tax_basis = 'inc_tax' AND tax_conversion IS NOT NULL)),
  CHECK ((source_kind = 'investment' AND version_no = 1 AND ((work_finance_revision IS NOT NULL AND committee_term_version_id IS NULL) OR (work_finance_revision IS NULL AND committee_term_version_id IS NOT NULL)) AND contract_reference IS NULL AND contract_signed_on IS NULL AND counterparty_partner_id IS NULL AND contract_amount_yen IS NULL AND contract_tax_basis IS NULL AND added_yen IS NULL AND burden_type IS NULL) OR (source_kind = 'contract' AND version_no = 1 AND tax_basis = 'ex_tax' AND work_finance_revision IS NULL AND committee_term_version_id IS NULL AND contract_reference IS NOT NULL AND contract_signed_on IS NOT NULL AND counterparty_partner_id IS NOT NULL AND contract_amount_yen IS NOT NULL AND contract_tax_basis IS NOT NULL AND added_yen IS NULL AND burden_type IS NULL AND ((contract_tax_basis = 'ex_tax' AND amount_yen = contract_amount_yen) OR (contract_tax_basis = 'inc_tax' AND amount_yen <= contract_amount_yen))) OR (source_kind = 'additional_contract' AND version_no > 1 AND work_finance_revision IS NULL AND committee_term_version_id IS NULL AND contract_reference IS NOT NULL AND contract_signed_on IS NOT NULL AND counterparty_partner_id IS NOT NULL AND contract_amount_yen IS NOT NULL AND contract_tax_basis IS NOT NULL AND added_yen IS NOT NULL AND burden_type IS NOT NULL AND ((contract_tax_basis = 'ex_tax' AND added_yen = contract_amount_yen) OR (contract_tax_basis = 'inc_tax' AND added_yen <= contract_amount_yen))))
);
CREATE FUNCTION production_cost_versions_sequence_fn() RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  IF (NEW.version_no <> (SELECT COALESCE(max(v.version_no), 0) + 1 FROM production_cost_versions v WHERE v.org_id = NEW.org_id AND v.work_id = NEW.work_id)) IS NOT TRUE THEN RETURN NEW; END IF;
  RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'stale production cost version';
  RETURN NEW;
END
$fn$;
CREATE TRIGGER production_cost_versions_sequence BEFORE INSERT ON production_cost_versions FOR EACH ROW EXECUTE FUNCTION production_cost_versions_sequence_fn();
CREATE FUNCTION production_cost_versions_own_investment_fn() RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  IF (NEW.version_no = (SELECT COALESCE(max(v.version_no), 0) + 1 FROM production_cost_versions v WHERE v.org_id = NEW.org_id AND v.work_id = NEW.work_id) AND NEW.source_kind = 'investment' AND NEW.work_finance_revision IS NOT NULL AND NEW.committee_term_version_id IS NULL AND NOT EXISTS (SELECT 1 FROM work_finance_versions f WHERE f.org_id = NEW.org_id AND f.work_id = NEW.work_id AND f.revision = NEW.work_finance_revision AND f.revision = (SELECT max(x.revision) FROM work_finance_versions x WHERE x.org_id = NEW.org_id AND x.work_id = NEW.work_id) AND f.own_investment_status = 'confirmed' AND f.own_investment_yen = NEW.amount_yen AND f.own_investment_tax_basis = NEW.tax_basis)) IS NOT TRUE THEN RETURN NEW; END IF;
  RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'production cost version must match the latest confirmed own investment';
  RETURN NEW;
END
$fn$;
CREATE TRIGGER production_cost_versions_own_investment BEFORE INSERT ON production_cost_versions FOR EACH ROW EXECUTE FUNCTION production_cost_versions_own_investment_fn();
CREATE FUNCTION production_cost_versions_committee_investment_fn() RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  IF (NEW.version_no = (SELECT COALESCE(max(v.version_no), 0) + 1 FROM production_cost_versions v WHERE v.org_id = NEW.org_id AND v.work_id = NEW.work_id) AND NEW.source_kind = 'investment' AND NEW.committee_term_version_id IS NOT NULL AND NEW.work_finance_revision IS NULL AND (NEW.tax_basis <> 'unknown' OR NOT EXISTS (SELECT 1 FROM committee_term_versions t JOIN committee_contracts c ON c.org_id = t.org_id AND c.id = t.contract_id JOIN committee_term_funding f ON f.org_id = t.org_id AND f.term_version_id = t.id WHERE t.org_id = NEW.org_id AND t.id = NEW.committee_term_version_id AND c.work_id = NEW.work_id AND f.production_cost_yen = NEW.amount_yen AND t.version_no = (SELECT max(x.version_no) FROM committee_term_versions x WHERE x.org_id = t.org_id AND x.contract_id = t.contract_id)) OR NEW.amount_yen <> (SELECT COALESCE(SUM(i.amount_yen), 0) FROM committee_term_investments i WHERE i.org_id = NEW.org_id AND i.term_version_id = NEW.committee_term_version_id))) IS NOT TRUE THEN RETURN NEW; END IF;
  RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'production cost version must match the latest committee investment';
  RETURN NEW;
END
$fn$;
CREATE TRIGGER production_cost_versions_committee_investment BEFORE INSERT ON production_cost_versions FOR EACH ROW EXECUTE FUNCTION production_cost_versions_committee_investment_fn();
CREATE FUNCTION production_cost_versions_additional_amount_fn() RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  IF (NEW.version_no = (SELECT COALESCE(max(v.version_no), 0) + 1 FROM production_cost_versions v WHERE v.org_id = NEW.org_id AND v.work_id = NEW.work_id) AND NEW.source_kind = 'additional_contract' AND EXISTS (SELECT 1 FROM production_cost_versions p WHERE p.org_id = NEW.org_id AND p.work_id = NEW.work_id AND p.version_no = NEW.version_no - 1 AND (p.amount_yen + NEW.added_yen <> NEW.amount_yen OR p.tax_basis <> NEW.tax_basis))) IS NOT TRUE THEN RETURN NEW; END IF;
  RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'production cost version must add the additional contract to the previous version';
  RETURN NEW;
END
$fn$;
CREATE TRIGGER production_cost_versions_additional_amount BEFORE INSERT ON production_cost_versions FOR EACH ROW EXECUTE FUNCTION production_cost_versions_additional_amount_fn();
CREATE TRIGGER production_cost_versions_no_update BEFORE UPDATE ON production_cost_versions FOR EACH ROW EXECUTE FUNCTION lite_reject_change('production cost version is append-only');
CREATE TRIGGER production_cost_versions_no_delete BEFORE DELETE ON production_cost_versions FOR EACH ROW EXECUTE FUNCTION lite_reject_change('production cost version is append-only');

-- ===== 0017_kpi_metric_master.sql =====
INSERT INTO yojitsu_variables (code, label, value_kind, per_step, sort_order) VALUES
  ('sales_multiplier', '窓口の売上の倍率', 'bps', 0, 5),
  ('recovery_amount', '回収の量', 'bps', 0, 6),
  ('months_to_contract', '契約までの月数', 'months', 0, 7),
  ('months_to_window', '窓口に出るまでの月数', 'months', 0, 8),
  ('payment_delay', '入金の遅れ', 'months', 0, 9),
  ('cost_overrun', '受託の実費の超過', 'bps', 0, 10),
  ('deal_mg', '1件の MG', 'yen', 0, 11),
  ('prep_cost', '1件の商品化の費用', 'yen', 0, 12),
  ('videogram_cost', '1件のビデオグラムの製造費', 'yen', 0, 13),
  ('labor_share', '制作費のうち人へ渡る割合', 'bps', 0, 14),
  ('pass_rate', '段階・交渉が通る確率', 'bps', 0, 15),
  ('work_hours', '月の業務時間', 'x100', 0, 16),
  ('step_hours', '1件の時間', 'x100', 1, 17),
  ('delivery_hours', '成約後の実行の月の時間', 'x100', 0, 18),
  ('delivery_months', '成約後の実行の月数', 'months', 0, 19),
  ('channel_share', '窓口の比率', 'bps', 0, 20),
  ('rate_window', '通過率を測る期間', 'months', 0, 21),
  ('rate_min_count', '通過率の最小件数', 'x100', 0, 22);
CREATE TABLE kpi_metric_versions (
  id bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  org_id bigint NOT NULL,
  version_no bigint NOT NULL CHECK (lite_typeof(version_no) = 'integer' AND version_no > 0),
  step_count bigint NOT NULL CHECK (lite_typeof(step_count) = 'integer' AND step_count BETWEEN 1 AND 200),
  basis text COLLATE "C" CHECK (basis IS NULL OR length(trim(basis)) BETWEEN 1 AND 1000),
  created_on text COLLATE "C" NOT NULL CHECK (length(created_on) = 10 AND substr(created_on, 5, 1) = '-' AND substr(created_on, 8, 1) = '-' AND ltrim(substr(created_on, 1, 4) || substr(created_on, 6, 2) || substr(created_on, 9, 2), '0123456789') = '' AND substr(created_on, 6, 2) BETWEEN '01' AND '12' AND substr(created_on, 9, 2) BETWEEN '01' AND '31'),
  created_by bigint NOT NULL,
  created_at text COLLATE "C" NOT NULL DEFAULT to_char(statement_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS'),
  UNIQUE (org_id, id),
  UNIQUE (org_id, version_no)
);
CREATE FUNCTION kpi_metric_versions_sequence_fn() RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  IF (NEW.version_no <> (SELECT COALESCE(max(v.version_no), 0) + 1 FROM kpi_metric_versions v WHERE v.org_id = NEW.org_id)) IS NOT TRUE THEN RETURN NEW; END IF;
  RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'stale kpi metric version';
  RETURN NEW;
END
$fn$;
CREATE TRIGGER kpi_metric_versions_sequence BEFORE INSERT ON kpi_metric_versions FOR EACH ROW EXECUTE FUNCTION kpi_metric_versions_sequence_fn();
CREATE TRIGGER kpi_metric_versions_no_update BEFORE UPDATE ON kpi_metric_versions FOR EACH ROW EXECUTE FUNCTION lite_reject_change('kpi metric version is append-only');
CREATE TRIGGER kpi_metric_versions_no_delete BEFORE DELETE ON kpi_metric_versions FOR EACH ROW EXECUTE FUNCTION lite_reject_change('kpi metric version is append-only');
CREATE TABLE kpi_metric_steps (
  org_id bigint NOT NULL,
  metric_version_id bigint NOT NULL,
  role text COLLATE "C" NOT NULL CHECK (role IN ('producer', 'sales_sourcing', 'sales_selling')),
  earning_type text COLLATE "C" NOT NULL,
  seq bigint NOT NULL CHECK (lite_typeof(seq) = 'integer' AND seq BETWEEN 1 AND 20),
  step text COLLATE "C" NOT NULL,
  status text COLLATE "C" NOT NULL CHECK (status IN ('confirmed', 'director_reported', 'press_reported', 'provisional')),
  basis text COLLATE "C" CHECK (basis IS NULL OR length(trim(basis)) BETWEEN 1 AND 1000),
  PRIMARY KEY (org_id, metric_version_id, role, earning_type, seq),
  UNIQUE (org_id, metric_version_id, earning_type, step)
);
CREATE FUNCTION kpi_metric_steps_count_fn() RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  IF ((SELECT COUNT(*) FROM kpi_metric_steps s WHERE s.org_id = NEW.org_id AND s.metric_version_id = NEW.metric_version_id) >= (SELECT v.step_count FROM kpi_metric_versions v WHERE v.org_id = NEW.org_id AND v.id = NEW.metric_version_id)) IS NOT TRUE THEN RETURN NEW; END IF;
  RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'kpi metric step beyond the count';
  RETURN NEW;
END
$fn$;
CREATE TRIGGER kpi_metric_steps_count BEFORE INSERT ON kpi_metric_steps FOR EACH ROW EXECUTE FUNCTION kpi_metric_steps_count_fn();
CREATE FUNCTION kpi_metric_steps_in_order_fn() RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  IF (NOT ((SELECT COUNT(*) FROM kpi_metric_steps s WHERE s.org_id = NEW.org_id AND s.metric_version_id = NEW.metric_version_id) >= (SELECT v.step_count FROM kpi_metric_versions v WHERE v.org_id = NEW.org_id AND v.id = NEW.metric_version_id)) AND NEW.seq <> (SELECT COALESCE(max(s.seq), 0) + 1 FROM kpi_metric_steps s WHERE s.org_id = NEW.org_id AND s.metric_version_id = NEW.metric_version_id AND s.role = NEW.role AND s.earning_type = NEW.earning_type)) IS NOT TRUE THEN RETURN NEW; END IF;
  RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'kpi metric step out of order';
  RETURN NEW;
END
$fn$;
CREATE TRIGGER kpi_metric_steps_in_order BEFORE INSERT ON kpi_metric_steps FOR EACH ROW EXECUTE FUNCTION kpi_metric_steps_in_order_fn();
CREATE TRIGGER kpi_metric_steps_no_update BEFORE UPDATE ON kpi_metric_steps FOR EACH ROW EXECUTE FUNCTION lite_reject_change('kpi metric version is append-only');
CREATE TRIGGER kpi_metric_steps_no_delete BEFORE DELETE ON kpi_metric_steps FOR EACH ROW EXECUTE FUNCTION lite_reject_change('kpi metric version is append-only');

-- ===== 0018_yojitsu_choice_settings.sql =====
CREATE TABLE yojitsu_choice_versions (
  id bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  org_id bigint NOT NULL,
  choice_key text COLLATE "C" NOT NULL CHECK (choice_key IN ('adopted_scenario', 'monthly_scope', 'closed_month')),
  version_no bigint NOT NULL CHECK (lite_typeof(version_no) = 'integer' AND version_no > 0),
  value_code text COLLATE "C",
  value_month text COLLATE "C" CHECK (value_month IS NULL OR (length(value_month) = 10 AND substr(value_month, 5, 1) = '-' AND substr(value_month, 8, 1) = '-' AND ltrim(substr(value_month, 1, 4) || substr(value_month, 6, 2), '0123456789') = '' AND substr(value_month, 6, 2) BETWEEN '01' AND '12' AND substr(value_month, 9, 2) = '01')),
  basis text COLLATE "C" CHECK (basis IS NULL OR length(trim(basis)) BETWEEN 1 AND 1000),
  created_by bigint NOT NULL,
  created_at text COLLATE "C" NOT NULL DEFAULT to_char(statement_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS'),
  UNIQUE (org_id, id),
  UNIQUE (org_id, choice_key, version_no),
  CHECK ((choice_key = 'adopted_scenario' AND value_code IS NOT NULL AND value_code IN ('even', 'good', 'max', 'single') AND value_month IS NULL) OR (choice_key = 'monthly_scope' AND value_code IS NOT NULL AND value_code IN ('all', 'landing', 'contracted') AND value_month IS NULL) OR (choice_key = 'closed_month' AND value_code IS NULL AND value_month IS NOT NULL))
);
CREATE FUNCTION yojitsu_choice_versions_sequence_fn() RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  IF (NEW.version_no <> (SELECT COALESCE(max(c.version_no), 0) + 1 FROM yojitsu_choice_versions c WHERE c.org_id = NEW.org_id AND c.choice_key = NEW.choice_key)) IS NOT TRUE THEN RETURN NEW; END IF;
  RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'stale yojitsu choice version';
  RETURN NEW;
END
$fn$;
CREATE TRIGGER yojitsu_choice_versions_sequence BEFORE INSERT ON yojitsu_choice_versions FOR EACH ROW EXECUTE FUNCTION yojitsu_choice_versions_sequence_fn();
CREATE TRIGGER yojitsu_choice_versions_no_update BEFORE UPDATE ON yojitsu_choice_versions FOR EACH ROW EXECUTE FUNCTION lite_reject_change('yojitsu choice version is append-only');
CREATE TRIGGER yojitsu_choice_versions_no_delete BEFORE DELETE ON yojitsu_choice_versions FOR EACH ROW EXECUTE FUNCTION lite_reject_change('yojitsu choice version is append-only');

-- ===== 0019_investment_approval_versions.sql =====
CREATE TABLE investment_approval_versions (
  org_id bigint NOT NULL,
  project_id bigint NOT NULL,
  approval_no bigint NOT NULL CHECK (lite_typeof(approval_no) = 'integer' AND approval_no > 0),
  version_no bigint NOT NULL CHECK (lite_typeof(version_no) = 'integer' AND version_no > 0),
  status text COLLATE "C" NOT NULL CHECK (status IN ('applied', 'approved', 'rejected', 'paid')),
  amount_yen bigint NOT NULL CHECK (lite_typeof(amount_yen) = 'integer' AND amount_yen BETWEEN 1 AND 1000000000000),
  basis_reference text COLLATE "C" CHECK (basis_reference IS NULL OR length(trim(basis_reference)) BETWEEN 1 AND 500),
  paid_on text COLLATE "C" CHECK (paid_on IS NULL OR (length(paid_on) = 10 AND substr(paid_on, 5, 1) = '-' AND substr(paid_on, 8, 1) = '-' AND ltrim(substr(paid_on, 1, 4) || substr(paid_on, 6, 2) || substr(paid_on, 9, 2), '0123456789') = '' AND substr(paid_on, 6, 2) BETWEEN '01' AND '12' AND substr(paid_on, 9, 2) BETWEEN '01' AND '31')),
  note text COLLATE "C" CHECK (note IS NULL OR length(trim(note)) BETWEEN 1 AND 1000),
  created_by bigint NOT NULL,
  created_at text COLLATE "C" NOT NULL DEFAULT to_char(statement_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS'),
  PRIMARY KEY (org_id, project_id, approval_no, version_no),
  CHECK (version_no > 1 OR status = 'applied'),
  CHECK ((status = 'paid' AND paid_on IS NOT NULL) OR (status <> 'paid' AND paid_on IS NULL)),
  CHECK (status NOT IN ('applied', 'rejected') OR basis_reference IS NOT NULL)
);
CREATE FUNCTION investment_approval_versions_own_investment_fn() RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  IF (NOT EXISTS (SELECT 1 FROM projects p WHERE p.org_id = NEW.org_id AND p.id = NEW.project_id AND p.earning_type = 'own_investment')) IS NOT TRUE THEN RETURN NEW; END IF;
  RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'investment approval needs an own investment project';
  RETURN NEW;
END
$fn$;
CREATE TRIGGER investment_approval_versions_own_investment BEFORE INSERT ON investment_approval_versions FOR EACH ROW EXECUTE FUNCTION investment_approval_versions_own_investment_fn();
CREATE FUNCTION investment_approval_versions_sequence_fn() RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  IF (EXISTS (SELECT 1 FROM projects p WHERE p.org_id = NEW.org_id AND p.id = NEW.project_id AND p.earning_type = 'own_investment') AND (NEW.version_no <> (SELECT COALESCE(max(v.version_no), 0) + 1 FROM investment_approval_versions v WHERE v.org_id = NEW.org_id AND v.project_id = NEW.project_id AND v.approval_no = NEW.approval_no) OR (NEW.version_no = 1 AND NEW.approval_no <> (SELECT COALESCE(max(a.approval_no), 0) + 1 FROM investment_approval_versions a WHERE a.org_id = NEW.org_id AND a.project_id = NEW.project_id)))) IS NOT TRUE THEN RETURN NEW; END IF;
  RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'stale investment approval version';
  RETURN NEW;
END
$fn$;
CREATE TRIGGER investment_approval_versions_sequence BEFORE INSERT ON investment_approval_versions FOR EACH ROW EXECUTE FUNCTION investment_approval_versions_sequence_fn();
CREATE FUNCTION investment_approval_versions_paid_after_approval_fn() RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  IF (EXISTS (SELECT 1 FROM projects p WHERE p.org_id = NEW.org_id AND p.id = NEW.project_id AND p.earning_type = 'own_investment') AND NEW.version_no = (SELECT COALESCE(max(v.version_no), 0) + 1 FROM investment_approval_versions v WHERE v.org_id = NEW.org_id AND v.project_id = NEW.project_id AND v.approval_no = NEW.approval_no) AND NEW.status = 'paid' AND NEW.version_no > 1 AND NOT EXISTS (SELECT 1 FROM investment_approval_versions v WHERE v.org_id = NEW.org_id AND v.project_id = NEW.project_id AND v.approval_no = NEW.approval_no AND v.version_no = NEW.version_no - 1 AND v.status IN ('approved', 'paid'))) IS NOT TRUE THEN RETURN NEW; END IF;
  RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'investment approval must be approved before payment';
  RETURN NEW;
END
$fn$;
CREATE TRIGGER investment_approval_versions_paid_after_approval BEFORE INSERT ON investment_approval_versions FOR EACH ROW EXECUTE FUNCTION investment_approval_versions_paid_after_approval_fn();
CREATE FUNCTION investment_approval_versions_step_fn() RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  IF (EXISTS (SELECT 1 FROM projects p WHERE p.org_id = NEW.org_id AND p.id = NEW.project_id AND p.earning_type = 'own_investment') AND NEW.version_no = (SELECT COALESCE(max(v.version_no), 0) + 1 FROM investment_approval_versions v WHERE v.org_id = NEW.org_id AND v.project_id = NEW.project_id AND v.approval_no = NEW.approval_no) AND NEW.status <> 'paid' AND NEW.version_no > 1 AND NOT EXISTS (SELECT 1 FROM investment_approval_versions v WHERE v.org_id = NEW.org_id AND v.project_id = NEW.project_id AND v.approval_no = NEW.approval_no AND v.version_no = NEW.version_no - 1 AND ((v.status IN ('applied', 'rejected') AND NEW.status = 'applied') OR (v.status = 'applied' AND NEW.status IN ('approved', 'rejected'))))) IS NOT TRUE THEN RETURN NEW; END IF;
  RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'investment approval step is not allowed';
  RETURN NEW;
END
$fn$;
CREATE TRIGGER investment_approval_versions_step BEFORE INSERT ON investment_approval_versions FOR EACH ROW EXECUTE FUNCTION investment_approval_versions_step_fn();
CREATE FUNCTION investment_approval_versions_decision_amount_fn() RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  IF (EXISTS (SELECT 1 FROM projects p WHERE p.org_id = NEW.org_id AND p.id = NEW.project_id AND p.earning_type = 'own_investment') AND NEW.version_no = (SELECT COALESCE(max(v.version_no), 0) + 1 FROM investment_approval_versions v WHERE v.org_id = NEW.org_id AND v.project_id = NEW.project_id AND v.approval_no = NEW.approval_no) AND NEW.status IN ('approved', 'rejected') AND EXISTS (SELECT 1 FROM investment_approval_versions v WHERE v.org_id = NEW.org_id AND v.project_id = NEW.project_id AND v.approval_no = NEW.approval_no AND v.version_no = NEW.version_no - 1 AND v.status = 'applied' AND v.amount_yen <> NEW.amount_yen)) IS NOT TRUE THEN RETURN NEW; END IF;
  RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'investment approval decision must keep the applied amount';
  RETURN NEW;
END
$fn$;
CREATE TRIGGER investment_approval_versions_decision_amount BEFORE INSERT ON investment_approval_versions FOR EACH ROW EXECUTE FUNCTION investment_approval_versions_decision_amount_fn();
CREATE FUNCTION investment_approval_versions_paid_total_fn() RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  IF (EXISTS (SELECT 1 FROM projects p WHERE p.org_id = NEW.org_id AND p.id = NEW.project_id AND p.earning_type = 'own_investment') AND NEW.version_no = (SELECT COALESCE(max(v.version_no), 0) + 1 FROM investment_approval_versions v WHERE v.org_id = NEW.org_id AND v.project_id = NEW.project_id AND v.approval_no = NEW.approval_no) AND NEW.status = 'paid' AND EXISTS (SELECT 1 FROM investment_approval_versions v WHERE v.org_id = NEW.org_id AND v.project_id = NEW.project_id AND v.approval_no = NEW.approval_no AND v.version_no = NEW.version_no - 1 AND v.status IN ('approved', 'paid')) AND NEW.amount_yen + (SELECT COALESCE(SUM(s.amount_yen), 0) FROM investment_approval_versions s WHERE s.org_id = NEW.org_id AND s.project_id = NEW.project_id AND s.approval_no = NEW.approval_no AND s.status = 'paid') > (SELECT max(a.amount_yen) FROM investment_approval_versions a WHERE a.org_id = NEW.org_id AND a.project_id = NEW.project_id AND a.approval_no = NEW.approval_no AND a.status = 'approved')) IS NOT TRUE THEN RETURN NEW; END IF;
  RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'investment approval payments exceed the approved amount';
  RETURN NEW;
END
$fn$;
CREATE TRIGGER investment_approval_versions_paid_total BEFORE INSERT ON investment_approval_versions FOR EACH ROW EXECUTE FUNCTION investment_approval_versions_paid_total_fn();
CREATE TRIGGER investment_approval_versions_no_update BEFORE UPDATE ON investment_approval_versions FOR EACH ROW EXECUTE FUNCTION lite_reject_change('investment approval version is append-only');
CREATE TRIGGER investment_approval_versions_no_delete BEFORE DELETE ON investment_approval_versions FOR EACH ROW EXECUTE FUNCTION lite_reject_change('investment approval version is append-only');

-- ===== 0020_sales_activity_results.sql =====
ALTER TABLE sales_activities ADD COLUMN result text COLLATE "C" CHECK (result IS NULL OR result IN ('advanced', 'on_hold', 'lost'));

-- ===== 0021_folder_source_terms_report_voids.sql =====
CREATE TABLE sales_source_file_terms (
  id bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  org_id bigint NOT NULL,
  file_id bigint NOT NULL,
  version_no bigint NOT NULL CHECK (lite_typeof(version_no) = 'integer' AND version_no > 0),
  partner_id bigint NOT NULL,
  kind text COLLATE "C" NOT NULL CHECK (kind IN ('theatrical', 'digital', 'package', 'broadcast', 'other', 'publicity')),
  period_from text COLLATE "C" CHECK (period_from IS NULL OR (length(period_from) = 10 AND substr(period_from, 5, 1) = '-' AND substr(period_from, 8, 1) = '-' AND ltrim(substr(period_from, 1, 4) || substr(period_from, 6, 2) || substr(period_from, 9, 2), '0123456789') = '' AND substr(period_from, 6, 2) BETWEEN '01' AND '12' AND substr(period_from, 9, 2) BETWEEN '01' AND '31')),
  period_to text COLLATE "C" CHECK (period_to IS NULL OR (length(period_to) = 10 AND substr(period_to, 5, 1) = '-' AND substr(period_to, 8, 1) = '-' AND ltrim(substr(period_to, 1, 4) || substr(period_to, 6, 2) || substr(period_to, 9, 2), '0123456789') = '' AND substr(period_to, 6, 2) BETWEEN '01' AND '12' AND substr(period_to, 9, 2) BETWEEN '01' AND '31')),
  received_on text COLLATE "C" CHECK (received_on IS NULL OR (length(received_on) = 10 AND substr(received_on, 5, 1) = '-' AND substr(received_on, 8, 1) = '-' AND ltrim(substr(received_on, 1, 4) || substr(received_on, 6, 2) || substr(received_on, 9, 2), '0123456789') = '' AND substr(received_on, 6, 2) BETWEEN '01' AND '12' AND substr(received_on, 9, 2) BETWEEN '01' AND '31')),
  report_month text COLLATE "C" CHECK (report_month IS NULL OR (length(report_month) = 7 AND substr(report_month, 5, 1) = '-' AND ltrim(substr(report_month, 1, 4) || substr(report_month, 6, 2), '0123456789') = '' AND substr(report_month, 6, 2) BETWEEN '01' AND '12')),
  declared_row_count bigint CHECK (declared_row_count IS NULL OR (lite_typeof(declared_row_count) = 'integer' AND declared_row_count BETWEEN 0 AND 9007199254740991)),
  declared_amount_ex_tax bigint CHECK (declared_amount_ex_tax IS NULL OR (lite_typeof(declared_amount_ex_tax) = 'integer' AND declared_amount_ex_tax BETWEEN - 9007199254740991 AND 9007199254740991)),
  declared_tax_amount bigint CHECK (declared_tax_amount IS NULL OR (lite_typeof(declared_tax_amount) = 'integer' AND declared_tax_amount BETWEEN - 9007199254740991 AND 9007199254740991)),
  declared_amount_inc_tax bigint CHECK (declared_amount_inc_tax IS NULL OR (lite_typeof(declared_amount_inc_tax) = 'integer' AND declared_amount_inc_tax BETWEEN - 9007199254740991 AND 9007199254740991)),
  reason text COLLATE "C" NOT NULL CHECK (length(trim(reason)) BETWEEN 1 AND 500),
  created_by bigint NOT NULL,
  created_at text COLLATE "C" NOT NULL DEFAULT to_char(statement_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS'),
  UNIQUE (org_id, id),
  UNIQUE (org_id, file_id, version_no),
  CHECK ((period_from IS NULL AND period_to IS NULL) OR (period_from IS NOT NULL AND period_to IS NOT NULL AND period_to >= period_from)),
  CHECK (declared_amount_ex_tax IS NULL OR declared_tax_amount IS NULL OR declared_amount_inc_tax IS NULL OR declared_amount_inc_tax = declared_amount_ex_tax + declared_tax_amount)
);
CREATE FUNCTION sales_source_file_terms_sequence_fn() RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  IF (NEW.version_no <> (SELECT COALESCE(max(t.version_no), 0) + 1 FROM sales_source_file_terms t WHERE t.org_id = NEW.org_id AND t.file_id = NEW.file_id)) IS NOT TRUE THEN RETURN NEW; END IF;
  RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = '1通の条件の版の番号が連番ではありません（古い画面からの書き込みです）';
  RETURN NEW;
END
$fn$;
CREATE TRIGGER sales_source_file_terms_sequence BEFORE INSERT ON sales_source_file_terms FOR EACH ROW EXECUTE FUNCTION sales_source_file_terms_sequence_fn();
CREATE FUNCTION sales_source_file_terms_before_commit_fn() RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  IF (NEW.version_no = (SELECT COALESCE(max(t.version_no), 0) + 1 FROM sales_source_file_terms t WHERE t.org_id = NEW.org_id AND t.file_id = NEW.file_id) AND EXISTS (SELECT 1 FROM sales_source_commits x WHERE x.org_id = NEW.org_id AND x.file_id = NEW.file_id)) IS NOT TRUE THEN RETURN NEW; END IF;
  RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = '登録を始めた原本の1通の条件は変えられません';
  RETURN NEW;
END
$fn$;
CREATE TRIGGER sales_source_file_terms_before_commit BEFORE INSERT ON sales_source_file_terms FOR EACH ROW EXECUTE FUNCTION sales_source_file_terms_before_commit_fn();
CREATE TRIGGER sales_source_file_terms_no_update BEFORE UPDATE ON sales_source_file_terms FOR EACH ROW EXECUTE FUNCTION lite_reject_change('1通の条件の版は変更できません。新しい版を足してください');
CREATE TRIGGER sales_source_file_terms_no_delete BEFORE DELETE ON sales_source_file_terms FOR EACH ROW EXECUTE FUNCTION lite_reject_change('1通の条件の版は削除できません');
CREATE TABLE report_voids (
  org_id bigint NOT NULL,
  report_id bigint NOT NULL,
  reason text COLLATE "C" NOT NULL CHECK (length(trim(reason)) BETWEEN 1 AND 1000),
  created_by bigint NOT NULL,
  created_at text COLLATE "C" NOT NULL DEFAULT to_char(statement_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS'),
  PRIMARY KEY (org_id, report_id)
);
CREATE FUNCTION report_voids_requires_void_fn() RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  IF (NOT EXISTS (SELECT 1 FROM report_imports r WHERE r.org_id = NEW.org_id AND r.id = NEW.report_id AND r.status = 'void')) IS NOT TRUE THEN RETURN NEW; END IF;
  RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = '取消の記録は、同じ書き込みで報告を取消（void）にしてから足します';
  RETURN NEW;
END
$fn$;
CREATE TRIGGER report_voids_requires_void BEFORE INSERT ON report_voids FOR EACH ROW EXECUTE FUNCTION report_voids_requires_void_fn();
CREATE TRIGGER report_voids_no_update BEFORE UPDATE ON report_voids FOR EACH ROW EXECUTE FUNCTION lite_reject_change('報告の取消の記録は変更できません');
CREATE TRIGGER report_voids_no_delete BEFORE DELETE ON report_voids FOR EACH ROW EXECUTE FUNCTION lite_reject_change('報告の取消の記録は削除できません');

-- ===== 0023_folder_check_versions_cases_runs.sql =====
CREATE TABLE report_check_versions (
  id bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  org_id bigint NOT NULL,
  partner_id bigint NOT NULL,
  kind text COLLATE "C" NOT NULL CHECK (kind IN ('theatrical', 'digital', 'package', 'broadcast', 'other', 'publicity')),
  version_no bigint NOT NULL CHECK (lite_typeof(version_no) = 'integer' AND version_no > 0),
  mapping_version_id bigint NOT NULL,
  checks_json text COLLATE "C" NOT NULL CHECK (lite_json_valid(checks_json) AND lite_json_type(checks_json) = 'array' AND lite_json_array_length(checks_json) BETWEEN 0 AND 50 AND length(checks_json) BETWEEN 2 AND 4000),
  header_columns_json text COLLATE "C" NOT NULL CHECK (lite_json_valid(header_columns_json) AND lite_json_type(header_columns_json) = 'array' AND lite_json_array_length(header_columns_json) BETWEEN 1 AND 200 AND length(header_columns_json) BETWEEN 2 AND 4000),
  skip_rules_json text COLLATE "C" NOT NULL CHECK (lite_json_valid(skip_rules_json) AND lite_json_type(skip_rules_json) = 'array' AND lite_json_array_length(skip_rules_json) BETWEEN 0 AND 50 AND length(skip_rules_json) BETWEEN 2 AND 4000),
  money_columns_json text COLLATE "C" NOT NULL CHECK (lite_json_valid(money_columns_json) AND lite_json_type(money_columns_json) = 'object' AND length(money_columns_json) BETWEEN 2 AND 2000 AND lite_json_extract(money_columns_json, '$.amountExTax') IS NOT NULL AND length(lite_json_extract(money_columns_json, '$.amountExTax')) BETWEEN 1 AND 80 AND lite_json_extract(money_columns_json, '$.taxAmount') IS NOT NULL AND length(lite_json_extract(money_columns_json, '$.taxAmount')) BETWEEN 1 AND 80 AND lite_json_extract(money_columns_json, '$.amountIncTax') IS NOT NULL AND length(lite_json_extract(money_columns_json, '$.amountIncTax')) BETWEEN 1 AND 80),
  split_by_product bigint NOT NULL CHECK (lite_typeof(split_by_product) = 'integer' AND split_by_product IN (0, 1)),
  reason text COLLATE "C" NOT NULL CHECK (length(trim(reason)) BETWEEN 1 AND 500),
  created_by bigint NOT NULL,
  created_at text COLLATE "C" NOT NULL DEFAULT to_char(statement_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS'),
  UNIQUE (org_id, id),
  UNIQUE (org_id, partner_id, kind, version_no)
);
CREATE FUNCTION report_check_versions_sequence_fn() RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  IF (NEW.version_no <> (SELECT COALESCE(max(v.version_no), 0) + 1 FROM report_check_versions v WHERE v.org_id = NEW.org_id AND v.partner_id = NEW.partner_id AND v.kind = NEW.kind)) IS NOT TRUE THEN RETURN NEW; END IF;
  RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = '検査の決まりの版の番号が連番ではありません';
  RETURN NEW;
END
$fn$;
CREATE TRIGGER report_check_versions_sequence BEFORE INSERT ON report_check_versions FOR EACH ROW EXECUTE FUNCTION report_check_versions_sequence_fn();
CREATE FUNCTION report_check_versions_mapping_match_fn() RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  IF (NEW.version_no = (SELECT COALESCE(max(v.version_no), 0) + 1 FROM report_check_versions v WHERE v.org_id = NEW.org_id AND v.partner_id = NEW.partner_id AND v.kind = NEW.kind) AND NOT EXISTS (SELECT 1 FROM report_mapping_versions mv JOIN report_mapping_profiles p ON p.org_id = mv.org_id AND p.id = mv.profile_id WHERE mv.org_id = NEW.org_id AND mv.id = NEW.mapping_version_id AND p.partner_id = NEW.partner_id AND p.kind = NEW.kind)) IS NOT TRUE THEN RETURN NEW; END IF;
  RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = '検査の決まりの版が指す列対応の版は、同じ取引先と報告の種類のものです';
  RETURN NEW;
END
$fn$;
CREATE TRIGGER report_check_versions_mapping_match BEFORE INSERT ON report_check_versions FOR EACH ROW EXECUTE FUNCTION report_check_versions_mapping_match_fn();
CREATE TRIGGER report_check_versions_no_update BEFORE UPDATE ON report_check_versions FOR EACH ROW EXECUTE FUNCTION lite_reject_change('検査の決まりの版は変更できません。新しい版を足してください');
CREATE TRIGGER report_check_versions_no_delete BEFORE DELETE ON report_check_versions FOR EACH ROW EXECUTE FUNCTION lite_reject_change('検査の決まりの版は削除できません');
CREATE TABLE report_check_cases (
  id bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  org_id bigint NOT NULL,
  check_version_id bigint NOT NULL,
  origin text COLLATE "C" NOT NULL CHECK (origin IN ('normal', 'fractional', 'excluded', 'human_fix')),
  fictional bigint NOT NULL CHECK (lite_typeof(fictional) = 'integer' AND fictional = 1),
  input_json text COLLATE "C" NOT NULL CHECK (lite_json_valid(input_json) AND lite_json_type(input_json) = 'object' AND length(input_json) BETWEEN 2 AND 65536),
  expected_json text COLLATE "C" NOT NULL CHECK (lite_json_valid(expected_json) AND lite_json_type(expected_json) = 'object' AND length(expected_json) BETWEEN 2 AND 2000),
  reason text COLLATE "C" NOT NULL CHECK (length(trim(reason)) BETWEEN 1 AND 500),
  created_by bigint NOT NULL,
  created_at text COLLATE "C" NOT NULL DEFAULT to_char(statement_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS'),
  UNIQUE (org_id, id)
);
CREATE FUNCTION report_check_cases_human_fix_approval_fn() RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  IF (NEW.origin = 'human_fix' AND NOT EXISTS (SELECT 1 FROM memberships m WHERE m.org_id = NEW.org_id AND m.user_id = NEW.created_by AND m.role = 'admin' AND m.active = 1 AND (m.expires_at IS NULL OR m.expires_at > to_char(statement_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS'))) AND NOT EXISTS (SELECT 1 FROM project_memberships pm JOIN memberships m ON m.org_id = pm.org_id AND m.user_id = pm.user_id WHERE pm.org_id = NEW.org_id AND pm.user_id = NEW.created_by AND pm.permission = 'edit' AND m.active = 1 AND (m.expires_at IS NULL OR m.expires_at > to_char(statement_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')) AND (pm.expires_at IS NULL OR pm.expires_at > to_char(statement_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')))) IS NOT TRUE THEN RETURN NEW; END IF;
  RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = '人の直しを正解表に足せるのは、代表か財務担当だけです';
  RETURN NEW;
END
$fn$;
CREATE TRIGGER report_check_cases_human_fix_approval BEFORE INSERT ON report_check_cases FOR EACH ROW EXECUTE FUNCTION report_check_cases_human_fix_approval_fn();
CREATE TRIGGER report_check_cases_no_update BEFORE UPDATE ON report_check_cases FOR EACH ROW EXECUTE FUNCTION lite_reject_change('正解表の行は変更できません。新しい行を足してください');
CREATE TRIGGER report_check_cases_no_delete BEFORE DELETE ON report_check_cases FOR EACH ROW EXECUTE FUNCTION lite_reject_change('正解表の行は削除できません');
CREATE TABLE source_check_runs (
  id bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  org_id bigint NOT NULL,
  file_id bigint NOT NULL,
  check_version_id bigint NOT NULL,
  run_no bigint NOT NULL CHECK (lite_typeof(run_no) = 'integer' AND run_no > 0),
  checks_passed bigint NOT NULL CHECK (lite_typeof(checks_passed) = 'integer' AND checks_passed BETWEEN 0 AND 9007199254740991),
  checks_total bigint NOT NULL CHECK (lite_typeof(checks_total) = 'integer' AND checks_total BETWEEN 0 AND 9007199254740991 AND checks_passed <= checks_total),
  judgment text COLLATE "C" NOT NULL CHECK (judgment IN ('auto', 'human', 'human_record', 'shape', 'unread')),
  golden_matched bigint NOT NULL CHECK (lite_typeof(golden_matched) = 'integer' AND golden_matched BETWEEN 0 AND 9007199254740991),
  golden_total bigint NOT NULL CHECK (lite_typeof(golden_total) = 'integer' AND golden_total BETWEEN 0 AND 9007199254740991),
  created_at text COLLATE "C" NOT NULL DEFAULT to_char(statement_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS'),
  UNIQUE (org_id, id),
  UNIQUE (org_id, file_id, run_no)
);
CREATE FUNCTION source_check_runs_sequence_fn() RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  IF (NEW.run_no <> (SELECT COALESCE(max(r.run_no), 0) + 1 FROM source_check_runs r WHERE r.org_id = NEW.org_id AND r.file_id = NEW.file_id)) IS NOT TRUE THEN RETURN NEW; END IF;
  RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = '検査の回の番号が連番ではありません';
  RETURN NEW;
END
$fn$;
CREATE TRIGGER source_check_runs_sequence BEFORE INSERT ON source_check_runs FOR EACH ROW EXECUTE FUNCTION source_check_runs_sequence_fn();
CREATE TRIGGER source_check_runs_no_update BEFORE UPDATE ON source_check_runs FOR EACH ROW EXECUTE FUNCTION lite_reject_change('検査の結果の回は変更できません。新しい回を足してください');
CREATE TRIGGER source_check_runs_no_delete BEFORE DELETE ON source_check_runs FOR EACH ROW EXECUTE FUNCTION lite_reject_change('検査の結果の回は削除できません');
CREATE TABLE source_sampling_reviews (
  id bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  org_id bigint NOT NULL,
  check_run_id bigint NOT NULL,
  result text COLLATE "C" NOT NULL CHECK (result IN ('clean', 'type_error', 'source_error')),
  reason text COLLATE "C" NOT NULL CHECK (length(trim(reason)) BETWEEN 1 AND 500),
  created_by bigint NOT NULL,
  created_at text COLLATE "C" NOT NULL DEFAULT to_char(statement_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS'),
  UNIQUE (org_id, id)
);
CREATE TRIGGER source_sampling_reviews_no_update BEFORE UPDATE ON source_sampling_reviews FOR EACH ROW EXECUTE FUNCTION lite_reject_change('抜き取りの記録は変更できません');
CREATE TRIGGER source_sampling_reviews_no_delete BEFORE DELETE ON source_sampling_reviews FOR EACH ROW EXECUTE FUNCTION lite_reject_change('抜き取りの記録は削除できません');

-- ===== 0024_budget_books.sql =====
CREATE TABLE budget_versions (
  id bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  org_id bigint NOT NULL,
  project_id bigint NOT NULL,
  version_no bigint NOT NULL CHECK (lite_typeof(version_no) = 'integer' AND version_no > 0),
  source_kind text COLLATE "C" NOT NULL CHECK (source_kind IN ('file', 'screen', 'copy')),
  source_file_name text COLLATE "C" CHECK (source_file_name IS NULL OR length(trim(source_file_name)) BETWEEN 1 AND 240),
  previous_version_id bigint,
  tax_rate_bps bigint NOT NULL CHECK (lite_typeof(tax_rate_bps) = 'integer' AND tax_rate_bps BETWEEN 0 AND 9999),
  management_fee_yen bigint NOT NULL CHECK (lite_typeof(management_fee_yen) = 'integer' AND management_fee_yen BETWEEN 0 AND 1000000000000),
  contingency_yen bigint NOT NULL CHECK (lite_typeof(contingency_yen) = 'integer' AND contingency_yen BETWEEN 0 AND 1000000000000),
  sheet_created_on text COLLATE "C" CHECK (sheet_created_on IS NULL OR (length(sheet_created_on) = 10 AND substr(sheet_created_on, 5, 1) = '-' AND substr(sheet_created_on, 8, 1) = '-' AND ltrim(substr(sheet_created_on, 1, 4) || substr(sheet_created_on, 6, 2) || substr(sheet_created_on, 9, 2), '0123456789') = '')),
  header_notes text COLLATE "C" CHECK (header_notes IS NULL OR length(header_notes) BETWEEN 1 AND 2000),
  title text COLLATE "C" CHECK (title IS NULL OR length(trim(title)) BETWEEN 1 AND 200),
  reason text COLLATE "C" NOT NULL CHECK (length(trim(reason)) BETWEEN 1 AND 1000),
  created_by bigint NOT NULL,
  created_at text COLLATE "C" NOT NULL DEFAULT to_char(statement_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS'),
  UNIQUE (org_id, id),
  UNIQUE (org_id, project_id, version_no),
  UNIQUE (org_id, project_id, id),
  CHECK ((source_kind = 'file' AND source_file_name IS NOT NULL) OR (source_kind <> 'file' AND source_file_name IS NULL)),
  CHECK (source_kind <> 'copy' OR previous_version_id IS NOT NULL)
);
CREATE FUNCTION budget_versions_sequence_fn() RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  IF (NEW.version_no <> (SELECT COALESCE(max(v.version_no), 0) + 1 FROM budget_versions v WHERE v.org_id = NEW.org_id AND v.project_id = NEW.project_id)) IS NOT TRUE THEN RETURN NEW; END IF;
  RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'stale budget version';
  RETURN NEW;
END
$fn$;
CREATE TRIGGER budget_versions_sequence BEFORE INSERT ON budget_versions FOR EACH ROW EXECUTE FUNCTION budget_versions_sequence_fn();
CREATE TRIGGER budget_versions_no_update BEFORE UPDATE ON budget_versions FOR EACH ROW EXECUTE FUNCTION lite_reject_change('budget record immutable');
CREATE TRIGGER budget_versions_no_delete BEFORE DELETE ON budget_versions FOR EACH ROW EXECUTE FUNCTION lite_reject_change('budget record immutable');
CREATE INDEX budget_versions_author_idx ON budget_versions (org_id, created_by);
CREATE TABLE budget_version_lines (
  id bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  org_id bigint NOT NULL,
  project_id bigint NOT NULL,
  version_id bigint NOT NULL,
  category_code text COLLATE "C" NOT NULL CHECK (category_code IN ('A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J', 'K')),
  line_no bigint NOT NULL CHECK (lite_typeof(line_no) = 'integer' AND line_no BETWEEN 1 AND 1000),
  work_id bigint,
  department_id bigint CHECK (department_id IS NULL OR (lite_typeof(department_id) = 'integer' AND department_id > 0)),
  name text COLLATE "C" NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 200),
  unit_price_yen bigint CHECK (unit_price_yen IS NULL OR (lite_typeof(unit_price_yen) = 'integer' AND unit_price_yen BETWEEN 0 AND 1000000000000)),
  qty_milli bigint CHECK (qty_milli IS NULL OR (lite_typeof(qty_milli) = 'integer' AND qty_milli BETWEEN 0 AND 1000000000)),
  unit text COLLATE "C" CHECK (unit IS NULL OR length(trim(unit)) BETWEEN 1 AND 20),
  amount_ex_tax_yen bigint NOT NULL CHECK (lite_typeof(amount_ex_tax_yen) = 'integer' AND amount_ex_tax_yen BETWEEN 0 AND 1000000000000),
  confirmed_source text COLLATE "C" NOT NULL CHECK (confirmed_source IN ('none', 'manual', 'fill')),
  payment_month text COLLATE "C" CHECK (payment_month IS NULL OR (length(payment_month) = 7 AND substr(payment_month, 5, 1) = '-' AND ltrim(substr(payment_month, 1, 4) || substr(payment_month, 6, 2), '0123456789') = '' AND substr(payment_month, 6, 2) BETWEEN '01' AND '12')),
  source_cell text COLLATE "C" CHECK (source_cell IS NULL OR length(source_cell) BETWEEN 2 AND 12),
  note text COLLATE "C" CHECK (note IS NULL OR length(trim(note)) BETWEEN 1 AND 500),
  UNIQUE (org_id, id),
  UNIQUE (org_id, version_id, category_code, line_no)
);
CREATE FUNCTION budget_version_lines_fixed_fn() RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  IF (EXISTS (SELECT 1 FROM budget_fixes f WHERE f.org_id = NEW.org_id AND f.version_id = NEW.version_id)) IS NOT TRUE THEN RETURN NEW; END IF;
  RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'budget version already fixed';
  RETURN NEW;
END
$fn$;
CREATE TRIGGER budget_version_lines_fixed BEFORE INSERT ON budget_version_lines FOR EACH ROW EXECUTE FUNCTION budget_version_lines_fixed_fn();
CREATE TRIGGER budget_version_lines_no_update BEFORE UPDATE ON budget_version_lines FOR EACH ROW EXECUTE FUNCTION lite_reject_change('budget record immutable');
CREATE TRIGGER budget_version_lines_no_delete BEFORE DELETE ON budget_version_lines FOR EACH ROW EXECUTE FUNCTION lite_reject_change('budget record immutable');
CREATE INDEX budget_version_lines_version_idx ON budget_version_lines (org_id, version_id);
CREATE INDEX budget_version_lines_work_idx ON budget_version_lines (org_id, project_id, work_id);
CREATE TABLE budget_check_runs (
  id bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  org_id bigint NOT NULL,
  project_id bigint NOT NULL,
  version_id bigint NOT NULL,
  run_no bigint NOT NULL CHECK (lite_typeof(run_no) = 'integer' AND run_no > 0),
  verdict text COLLATE "C" NOT NULL CHECK (verdict IN ('draft_ok', 'exceptions')),
  passed bigint NOT NULL CHECK (lite_typeof(passed) = 'integer' AND passed >= 0),
  failed bigint NOT NULL CHECK (lite_typeof(failed) = 'integer' AND failed >= 0),
  checks_json text COLLATE "C" NOT NULL CHECK (lite_json_valid(checks_json) AND lite_json_type(checks_json) = 'array' AND length(checks_json) BETWEEN 2 AND 20000),
  created_by bigint NOT NULL,
  created_at text COLLATE "C" NOT NULL DEFAULT to_char(statement_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS'),
  UNIQUE (org_id, id),
  UNIQUE (org_id, version_id, run_no),
  CHECK ((verdict = 'draft_ok' AND failed = 0) OR (verdict = 'exceptions' AND failed > 0))
);
CREATE FUNCTION budget_check_runs_sequence_fn() RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  IF (NEW.run_no <> (SELECT COALESCE(max(r.run_no), 0) + 1 FROM budget_check_runs r WHERE r.org_id = NEW.org_id AND r.version_id = NEW.version_id)) IS NOT TRUE THEN RETURN NEW; END IF;
  RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'stale budget check run';
  RETURN NEW;
END
$fn$;
CREATE TRIGGER budget_check_runs_sequence BEFORE INSERT ON budget_check_runs FOR EACH ROW EXECUTE FUNCTION budget_check_runs_sequence_fn();
CREATE TRIGGER budget_check_runs_no_update BEFORE UPDATE ON budget_check_runs FOR EACH ROW EXECUTE FUNCTION lite_reject_change('budget record immutable');
CREATE TRIGGER budget_check_runs_no_delete BEFORE DELETE ON budget_check_runs FOR EACH ROW EXECUTE FUNCTION lite_reject_change('budget record immutable');
CREATE INDEX budget_check_runs_author_idx ON budget_check_runs (org_id, created_by);
CREATE TABLE budget_fixes (
  id bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  org_id bigint NOT NULL,
  project_id bigint NOT NULL,
  seq bigint NOT NULL CHECK (lite_typeof(seq) = 'integer' AND seq > 0),
  action text COLLATE "C" NOT NULL CHECK (action IN ('fix', 'void')),
  version_id bigint NOT NULL,
  reason text COLLATE "C" NOT NULL CHECK (length(trim(reason)) BETWEEN 1 AND 1000),
  created_by bigint NOT NULL,
  created_at text COLLATE "C" NOT NULL DEFAULT to_char(statement_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS'),
  UNIQUE (org_id, id),
  UNIQUE (org_id, project_id, seq)
);
CREATE FUNCTION budget_fixes_sequence_fn() RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  IF (NEW.seq <> (SELECT COALESCE(max(f.seq), 0) + 1 FROM budget_fixes f WHERE f.org_id = NEW.org_id AND f.project_id = NEW.project_id)) IS NOT TRUE THEN RETURN NEW; END IF;
  RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'stale budget fix';
  RETURN NEW;
END
$fn$;
CREATE TRIGGER budget_fixes_sequence BEFORE INSERT ON budget_fixes FOR EACH ROW EXECUTE FUNCTION budget_fixes_sequence_fn();
CREATE FUNCTION budget_fixes_requires_clean_check_fn() RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  IF (NEW.action = 'fix' AND NEW.seq = (SELECT COALESCE(max(f.seq), 0) + 1 FROM budget_fixes f WHERE f.org_id = NEW.org_id AND f.project_id = NEW.project_id) AND COALESCE((SELECT r.verdict FROM budget_check_runs r WHERE r.org_id = NEW.org_id AND r.version_id = NEW.version_id ORDER BY r.run_no DESC LIMIT 1), 'none') <> 'draft_ok') IS NOT TRUE THEN RETURN NEW; END IF;
  RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'budget version has exceptions';
  RETURN NEW;
END
$fn$;
CREATE TRIGGER budget_fixes_requires_clean_check BEFORE INSERT ON budget_fixes FOR EACH ROW EXECUTE FUNCTION budget_fixes_requires_clean_check_fn();
CREATE FUNCTION budget_fixes_void_current_fn() RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  IF (NEW.action = 'void' AND NEW.seq = (SELECT COALESCE(max(f.seq), 0) + 1 FROM budget_fixes f WHERE f.org_id = NEW.org_id AND f.project_id = NEW.project_id) AND NOT EXISTS (SELECT 1 FROM budget_fixes f WHERE f.org_id = NEW.org_id AND f.project_id = NEW.project_id AND f.seq = NEW.seq - 1 AND f.action = 'fix' AND f.version_id = NEW.version_id)) IS NOT TRUE THEN RETURN NEW; END IF;
  RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'budget fix is not current';
  RETURN NEW;
END
$fn$;
CREATE TRIGGER budget_fixes_void_current BEFORE INSERT ON budget_fixes FOR EACH ROW EXECUTE FUNCTION budget_fixes_void_current_fn();
CREATE TRIGGER budget_fixes_no_update BEFORE UPDATE ON budget_fixes FOR EACH ROW EXECUTE FUNCTION lite_reject_change('budget record immutable');
CREATE TRIGGER budget_fixes_no_delete BEFORE DELETE ON budget_fixes FOR EACH ROW EXECUTE FUNCTION lite_reject_change('budget record immutable');
CREATE INDEX budget_fixes_version_idx ON budget_fixes (org_id, version_id);
CREATE INDEX budget_fixes_author_idx ON budget_fixes (org_id, created_by);

-- ===== 0025_source_documents.sql =====
CREATE TABLE source_documents (
  id bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  org_id bigint NOT NULL,
  kind text COLLATE "C" NOT NULL CHECK (kind IN ('sales_report', 'contract', 'estimate', 'invoice', 'receipt', 'bank_statement', 'schedule', 'script', 'budget', 'planning_deck', 'delivery_guide', 'media', 'image', 'audio', 'other')),
  file_name text COLLATE "C" NOT NULL CHECK (length(trim(file_name)) BETWEEN 1 AND 240),
  media_type text COLLATE "C" CHECK (media_type IS NULL OR length(media_type) BETWEEN 1 AND 160),
  byte_length bigint NOT NULL CHECK (lite_typeof(byte_length) = 'integer' AND byte_length > 0),
  sha256 text COLLATE "C" NOT NULL CHECK (length(sha256) = 64 AND lower(sha256) = sha256 AND length(trim(sha256, '0123456789abcdef')) = 0),
  storage text COLLATE "C" NOT NULL CHECK (storage IN ('inline', 'external')),
  content_base64 text COLLATE "C",
  external_location text COLLATE "C" CHECK (external_location IS NULL OR length(trim(external_location)) BETWEEN 1 AND 500),
  received_on text COLLATE "C" NOT NULL CHECK (length(received_on) = 10 AND substr(received_on, 5, 1) = '-' AND substr(received_on, 8, 1) = '-'),
  received_by bigint NOT NULL,
  legacy_table text COLLATE "C" CHECK (legacy_table IS NULL OR legacy_table IN ('sales_source_files', 'expense_source_files', 'workflow_raw_artifacts')),
  legacy_id bigint CHECK (legacy_id IS NULL OR (lite_typeof(legacy_id) = 'integer' AND legacy_id > 0)),
  created_at text COLLATE "C" NOT NULL DEFAULT to_char(statement_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS'),
  UNIQUE (org_id, id),
  UNIQUE (org_id, sha256),
  UNIQUE (org_id, legacy_table, legacy_id),
  CHECK ((storage = 'inline' AND content_base64 IS NOT NULL AND external_location IS NULL AND byte_length <= 12582912) OR (storage = 'external' AND content_base64 IS NULL AND external_location IS NOT NULL)),
  CHECK ((legacy_table IS NULL AND legacy_id IS NULL) OR (legacy_table IS NOT NULL AND legacy_id IS NOT NULL))
);
CREATE INDEX source_documents_kind_received ON source_documents (org_id, kind, received_on);
CREATE TRIGGER source_documents_no_update BEFORE UPDATE ON source_documents FOR EACH ROW EXECUTE FUNCTION lite_reject_change('受け取った原本は変更できません');
CREATE TRIGGER source_documents_no_delete BEFORE DELETE ON source_documents FOR EACH ROW EXECUTE FUNCTION lite_reject_change('受け取った原本は削除できません');

-- ===== 0026_acq_mg_master.sql =====
CREATE TABLE acq_mg_contracts (
  id bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  org_id bigint NOT NULL,
  code text COLLATE "C" NOT NULL CHECK (length(trim(code)) BETWEEN 1 AND 40),
  title text COLLATE "C" NOT NULL CHECK (length(trim(title)) BETWEEN 1 AND 200),
  partner_id bigint NOT NULL,
  intake_case_id bigint,
  legacy_settlement_contract_id bigint,
  legacy_outgoing_contract_id bigint,
  created_by bigint NOT NULL,
  created_at text COLLATE "C" NOT NULL DEFAULT to_char(statement_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS'),
  UNIQUE (org_id, id),
  UNIQUE (org_id, code),
  UNIQUE (org_id, legacy_settlement_contract_id),
  UNIQUE (org_id, legacy_outgoing_contract_id)
);
CREATE TRIGGER acq_mg_contracts_no_update BEFORE UPDATE ON acq_mg_contracts FOR EACH ROW EXECUTE FUNCTION lite_reject_change('支払う MG の契約は変更できません。条件は新しい版を足してください');
CREATE TRIGGER acq_mg_contracts_no_delete BEFORE DELETE ON acq_mg_contracts FOR EACH ROW EXECUTE FUNCTION lite_reject_change('支払う MG の契約は削除できません');
CREATE TABLE acq_mg_term_versions (
  id bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  org_id bigint NOT NULL,
  contract_id bigint NOT NULL,
  version_no bigint NOT NULL CHECK (lite_typeof(version_no) = 'integer' AND version_no > 0),
  consideration text COLLATE "C" NOT NULL CHECK (consideration IN ('mg', 'buyout')),
  currency text COLLATE "C" NOT NULL DEFAULT 'JPY' CHECK (length(currency) = 3 AND upper(currency) = currency),
  mg_amount bigint NOT NULL CHECK (lite_typeof(mg_amount) = 'integer' AND mg_amount BETWEEN 0 AND 9007199254740991),
  starts_on text COLLATE "C" NOT NULL CHECK (length(starts_on) = 10 AND starts_on BETWEEN '1900-01-01' AND '2999-12-31'),
  ends_on text COLLATE "C" NOT NULL CHECK (length(ends_on) = 10 AND ends_on BETWEEN '1900-01-01' AND '2999-12-31'),
  recoup_basis text COLLATE "C" NOT NULL CHECK (recoup_basis IN ('platform_net', 'after_fee')),
  platform_rate_bps bigint NOT NULL DEFAULT 0 CHECK (lite_typeof(platform_rate_bps) = 'integer' AND platform_rate_bps BETWEEN 0 AND 10000),
  agency_fee_bps bigint CHECK (agency_fee_bps IS NULL OR (lite_typeof(agency_fee_bps) = 'integer' AND agency_fee_bps BETWEEN 0 AND 10000)),
  overage_enabled bigint CHECK (overage_enabled IS NULL OR overage_enabled IN (0, 1)),
  overage_rate_bps bigint CHECK (overage_rate_bps IS NULL OR (lite_typeof(overage_rate_bps) = 'integer' AND overage_rate_bps BETWEEN 0 AND 10000)),
  pooling text COLLATE "C" NOT NULL DEFAULT 'all_media' CHECK (pooling IN ('all_media', 'per_media')),
  shortfall_from_other_media bigint NOT NULL DEFAULT 0 CHECK (shortfall_from_other_media IN (0, 1)),
  multi_work text COLLATE "C" NOT NULL DEFAULT 'single' CHECK (multi_work IN ('single', 'actual', 'hold_until_total')),
  hold_agreement_ref text COLLATE "C" CHECK (hold_agreement_ref IS NULL OR length(trim(hold_agreement_ref)) BETWEEN 1 AND 200),
  reason text COLLATE "C" NOT NULL CHECK (length(trim(reason)) BETWEEN 1 AND 500),
  created_by bigint NOT NULL,
  created_at text COLLATE "C" NOT NULL DEFAULT to_char(statement_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS'),
  CHECK (ends_on >= starts_on),
  CHECK (recoup_basis <> 'after_fee' OR agency_fee_bps IS NOT NULL),
  CHECK ((overage_enabled IS NULL AND overage_rate_bps IS NULL) OR (overage_enabled = 0 AND overage_rate_bps IS NULL) OR (overage_enabled = 1 AND overage_rate_bps IS NOT NULL)),
  CHECK (consideration = 'mg' OR (overage_enabled = 0 AND overage_rate_bps IS NULL)),
  CHECK (multi_work <> 'hold_until_total' OR hold_agreement_ref IS NOT NULL),
  CHECK (pooling = 'per_media' OR shortfall_from_other_media = 0),
  UNIQUE (org_id, id),
  UNIQUE (org_id, contract_id, version_no)
);
CREATE FUNCTION acq_mg_term_versions_sequence_fn() RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  IF (NEW.version_no <> (SELECT COALESCE(max(v.version_no), 0) + 1 FROM acq_mg_term_versions v WHERE v.org_id = NEW.org_id AND v.contract_id = NEW.contract_id)) IS NOT TRUE THEN RETURN NEW; END IF;
  RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = '支払う MG の条件版の番号が連番ではありません';
  RETURN NEW;
END
$fn$;
CREATE TRIGGER acq_mg_term_versions_sequence BEFORE INSERT ON acq_mg_term_versions FOR EACH ROW EXECUTE FUNCTION acq_mg_term_versions_sequence_fn();
CREATE TRIGGER acq_mg_term_versions_no_update BEFORE UPDATE ON acq_mg_term_versions FOR EACH ROW EXECUTE FUNCTION lite_reject_change('支払う MG の条件版は変更できません。新しい版を足してください');
CREATE TRIGGER acq_mg_term_versions_no_delete BEFORE DELETE ON acq_mg_term_versions FOR EACH ROW EXECUTE FUNCTION lite_reject_change('支払う MG の条件版は削除できません');
CREATE TABLE acq_mg_term_works (
  org_id bigint NOT NULL,
  term_version_id bigint NOT NULL,
  work_id bigint NOT NULL,
  preset_amount bigint CHECK (preset_amount IS NULL OR (lite_typeof(preset_amount) = 'integer' AND preset_amount BETWEEN 0 AND 9007199254740991)),
  PRIMARY KEY (org_id, term_version_id, work_id)
);
CREATE TRIGGER acq_mg_term_works_no_update BEFORE UPDATE ON acq_mg_term_works FOR EACH ROW EXECUTE FUNCTION lite_reject_change('条件版の対象の作品は変更できません');
CREATE TRIGGER acq_mg_term_works_no_delete BEFORE DELETE ON acq_mg_term_works FOR EACH ROW EXECUTE FUNCTION lite_reject_change('条件版の対象の作品は削除できません');
CREATE TABLE acq_mg_term_deductions (
  org_id bigint NOT NULL,
  term_version_id bigint NOT NULL,
  category text COLLATE "C" NOT NULL CHECK (length(trim(category)) BETWEEN 1 AND 80),
  cap_amount bigint CHECK (cap_amount IS NULL OR (lite_typeof(cap_amount) = 'integer' AND cap_amount BETWEEN 0 AND 9007199254740991)),
  cap_bps bigint CHECK (cap_bps IS NULL OR (lite_typeof(cap_bps) = 'integer' AND cap_bps BETWEEN 0 AND 10000)),
  source_ref text COLLATE "C" NOT NULL CHECK (length(trim(source_ref)) BETWEEN 1 AND 200),
  PRIMARY KEY (org_id, term_version_id, category)
);
CREATE TRIGGER acq_mg_term_deductions_no_update BEFORE UPDATE ON acq_mg_term_deductions FOR EACH ROW EXECUTE FUNCTION lite_reject_change('分配の前に引く費目は変更できません');
CREATE TRIGGER acq_mg_term_deductions_no_delete BEFORE DELETE ON acq_mg_term_deductions FOR EACH ROW EXECUTE FUNCTION lite_reject_change('分配の前に引く費目は削除できません');
CREATE TABLE acq_mg_term_phases (
  org_id bigint NOT NULL,
  term_version_id bigint NOT NULL,
  phase_order bigint NOT NULL CHECK (lite_typeof(phase_order) = 'integer' AND phase_order BETWEEN 1 AND 20),
  starts_month text COLLATE "C" NOT NULL CHECK (length(starts_month) = 7 AND substr(starts_month, 5, 1) = '-' AND substr(starts_month, 6, 2) BETWEEN '01' AND '12' AND substr(starts_month, 1, 4) BETWEEN '1900' AND '2999'),
  ends_month text COLLATE "C" CHECK (ends_month IS NULL OR (length(ends_month) = 7 AND substr(ends_month, 5, 1) = '-' AND substr(ends_month, 6, 2) BETWEEN '01' AND '12' AND substr(ends_month, 1, 4) BETWEEN '1900' AND '2999')),
  cycle_kind text COLLATE "C" NOT NULL CHECK (cycle_kind IN ('monthly', 'quarterly', 'semiannual', 'annual', 'custom', 'manual', 'none')),
  anchor_month bigint CHECK (anchor_month IS NULL OR anchor_month BETWEEN 1 AND 12),
  custom_close_months text COLLATE "C" CHECK (custom_close_months IS NULL OR length(custom_close_months) BETWEEN 7 AND 2000),
  first_close_immediate bigint NOT NULL DEFAULT 0 CHECK (first_close_immediate IN (0, 1)),
  report_offset_months bigint NOT NULL DEFAULT 1 CHECK (report_offset_months BETWEEN 0 AND 24),
  report_day bigint CHECK (report_day IS NULL OR report_day BETWEEN 1 AND 31),
  payment_offset_months bigint NOT NULL DEFAULT 1 CHECK (payment_offset_months BETWEEN 0 AND 24),
  payment_day bigint CHECK (payment_day IS NULL OR payment_day BETWEEN 1 AND 31),
  PRIMARY KEY (org_id, term_version_id, phase_order),
  CHECK (ends_month IS NULL OR ends_month >= starts_month),
  CHECK ((cycle_kind IN ('quarterly', 'semiannual', 'annual') AND anchor_month IS NOT NULL) OR (cycle_kind NOT IN ('quarterly', 'semiannual', 'annual') AND anchor_month IS NULL)),
  CHECK ((cycle_kind = 'custom' AND custom_close_months IS NOT NULL) OR (cycle_kind <> 'custom' AND custom_close_months IS NULL)),
  CHECK (first_close_immediate = 0 OR cycle_kind IN ('quarterly', 'semiannual', 'annual', 'custom'))
);
CREATE TRIGGER acq_mg_term_phases_no_update BEFORE UPDATE ON acq_mg_term_phases FOR EACH ROW EXECUTE FUNCTION lite_reject_change('分配報告の周期は変更できません');
CREATE TRIGGER acq_mg_term_phases_no_delete BEFORE DELETE ON acq_mg_term_phases FOR EACH ROW EXECUTE FUNCTION lite_reject_change('分配報告の周期は削除できません');
CREATE TABLE acq_mg_term_media_allocations (
  org_id bigint NOT NULL,
  term_version_id bigint NOT NULL,
  media text COLLATE "C" NOT NULL CHECK (media IN ('flat', 'mg', 'rs', 'rss', 'vod')),
  amount bigint NOT NULL CHECK (lite_typeof(amount) = 'integer' AND amount BETWEEN 0 AND 9007199254740991),
  PRIMARY KEY (org_id, term_version_id, media)
);
CREATE TRIGGER acq_mg_term_media_allocations_no_update BEFORE UPDATE ON acq_mg_term_media_allocations FOR EACH ROW EXECUTE FUNCTION lite_reject_change('媒体ごとの配分は変更できません');
CREATE TRIGGER acq_mg_term_media_allocations_no_delete BEFORE DELETE ON acq_mg_term_media_allocations FOR EACH ROW EXECUTE FUNCTION lite_reject_change('媒体ごとの配分は削除できません');
CREATE TABLE acq_mg_payment_schedule (
  org_id bigint NOT NULL,
  term_version_id bigint NOT NULL,
  installment bigint NOT NULL CHECK (lite_typeof(installment) = 'integer' AND installment BETWEEN 1 AND 50),
  trigger_kind text COLLATE "C" NOT NULL CHECK (trigger_kind IN ('signing', 'delivery', 'release', 'date')),
  due_on text COLLATE "C" CHECK (due_on IS NULL OR (length(due_on) = 10 AND due_on BETWEEN '1900-01-01' AND '2999-12-31')),
  amount bigint NOT NULL CHECK (lite_typeof(amount) = 'integer' AND amount BETWEEN 0 AND 9007199254740991),
  PRIMARY KEY (org_id, term_version_id, installment),
  CHECK (trigger_kind <> 'date' OR due_on IS NOT NULL)
);
CREATE TRIGGER acq_mg_payment_schedule_no_update BEFORE UPDATE ON acq_mg_payment_schedule FOR EACH ROW EXECUTE FUNCTION lite_reject_change('MG の支払予定は変更できません。新しい条件版を足してください');
CREATE TRIGGER acq_mg_payment_schedule_no_delete BEFORE DELETE ON acq_mg_payment_schedule FOR EACH ROW EXECUTE FUNCTION lite_reject_change('MG の支払予定は削除できません');
CREATE TABLE acq_mg_report_links (
  id bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  org_id bigint NOT NULL,
  report_id bigint NOT NULL,
  work_id bigint NOT NULL,
  term_version_id bigint NOT NULL,
  report_basis text COLLATE "C" NOT NULL CHECK (report_basis IN ('gross', 'net')),
  decided_by text COLLATE "C" NOT NULL CHECK (decided_by IN ('auto', 'human')),
  decision text COLLATE "C" NOT NULL CHECK (decision IN ('include', 'exclude')),
  reason text COLLATE "C" NOT NULL CHECK (length(trim(reason)) BETWEEN 1 AND 500),
  replaces_link_id bigint,
  created_by bigint NOT NULL,
  created_at text COLLATE "C" NOT NULL DEFAULT to_char(statement_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS'),
  UNIQUE (org_id, id),
  UNIQUE (org_id, replaces_link_id)
);
CREATE FUNCTION acq_mg_report_links_single_chain_fn() RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  IF (NEW.replaces_link_id IS NULL AND EXISTS (SELECT 1 FROM acq_mg_report_links l WHERE l.org_id = NEW.org_id AND l.report_id = NEW.report_id AND l.work_id = NEW.work_id)) IS NOT TRUE THEN RETURN NEW; END IF;
  RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'この報告と作品は結び付け済みです。直すときは前の結び付けを指してください';
  RETURN NEW;
END
$fn$;
CREATE TRIGGER acq_mg_report_links_single_chain BEFORE INSERT ON acq_mg_report_links FOR EACH ROW EXECUTE FUNCTION acq_mg_report_links_single_chain_fn();
CREATE FUNCTION acq_mg_report_links_replace_scope_fn() RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  IF (NEW.replaces_link_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM acq_mg_report_links l WHERE l.org_id = NEW.org_id AND l.id = NEW.replaces_link_id AND l.report_id = NEW.report_id AND l.work_id = NEW.work_id)) IS NOT TRUE THEN RETURN NEW; END IF;
  RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = '直す元は同じ報告と作品の結び付けを指してください';
  RETURN NEW;
END
$fn$;
CREATE TRIGGER acq_mg_report_links_replace_scope BEFORE INSERT ON acq_mg_report_links FOR EACH ROW EXECUTE FUNCTION acq_mg_report_links_replace_scope_fn();
CREATE TRIGGER acq_mg_report_links_no_update BEFORE UPDATE ON acq_mg_report_links FOR EACH ROW EXECUTE FUNCTION lite_reject_change('結び付けは変更できません。直す行を足してください');
CREATE TRIGGER acq_mg_report_links_no_delete BEFORE DELETE ON acq_mg_report_links FOR EACH ROW EXECUTE FUNCTION lite_reject_change('結び付けは削除できません');
CREATE TABLE acq_mg_statements (
  id bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  org_id bigint NOT NULL,
  term_version_id bigint NOT NULL,
  close_month text COLLATE "C" NOT NULL CHECK (length(close_month) = 7 AND substr(close_month, 5, 1) = '-' AND substr(close_month, 6, 2) BETWEEN '01' AND '12' AND substr(close_month, 1, 4) BETWEEN '1900' AND '2999'),
  kind text COLLATE "C" NOT NULL CHECK (kind IN ('issue', 'void')),
  status text COLLATE "C" CHECK (status IS NULL OR status IN ('recouping', 'recouped', 'buyout', 'hold')),
  recouped bigint CHECK (recouped IS NULL OR lite_typeof(recouped) = 'integer'),
  balance bigint CHECK (balance IS NULL OR lite_typeof(balance) = 'integer'),
  overage bigint CHECK (overage IS NULL OR lite_typeof(overage) = 'integer'),
  distribution bigint CHECK (distribution IS NULL OR lite_typeof(distribution) = 'integer'),
  body_json text COLLATE "C" CHECK (body_json IS NULL OR (lite_json_valid(body_json) AND length(body_json) BETWEEN 2 AND 1000000)),
  body_sha256 text COLLATE "C" CHECK (body_sha256 IS NULL OR length(body_sha256) = 64),
  issued_on text COLLATE "C" NOT NULL CHECK (length(issued_on) = 10 AND issued_on BETWEEN '1900-01-01' AND '2999-12-31'),
  voids_statement_id bigint,
  reason text COLLATE "C" CHECK (reason IS NULL OR length(trim(reason)) BETWEEN 1 AND 500),
  created_by bigint NOT NULL,
  created_at text COLLATE "C" NOT NULL DEFAULT to_char(statement_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS'),
  CHECK ((kind = 'issue' AND status IS NOT NULL AND recouped IS NOT NULL AND balance IS NOT NULL AND overage IS NOT NULL AND body_json IS NOT NULL AND body_sha256 IS NOT NULL AND voids_statement_id IS NULL) OR (kind = 'void' AND status IS NULL AND recouped IS NULL AND balance IS NULL AND overage IS NULL AND distribution IS NULL AND body_json IS NULL AND body_sha256 IS NULL AND voids_statement_id IS NOT NULL AND reason IS NOT NULL)),
  UNIQUE (org_id, id),
  UNIQUE (org_id, voids_statement_id)
);
CREATE FUNCTION acq_mg_statements_void_scope_fn() RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  IF (NEW.kind = 'void' AND NOT EXISTS (SELECT 1 FROM acq_mg_statements s WHERE s.org_id = NEW.org_id AND s.id = NEW.voids_statement_id AND s.kind = 'issue' AND s.term_version_id = NEW.term_version_id AND s.close_month = NEW.close_month)) IS NOT TRUE THEN RETURN NEW; END IF;
  RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = '取り消せるのは、同じ条件版と締め月の発行した報告書だけです';
  RETURN NEW;
END
$fn$;
CREATE TRIGGER acq_mg_statements_void_scope BEFORE INSERT ON acq_mg_statements FOR EACH ROW EXECUTE FUNCTION acq_mg_statements_void_scope_fn();
CREATE FUNCTION acq_mg_statements_one_live_issue_fn() RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  IF (NEW.kind = 'issue' AND EXISTS (SELECT 1 FROM acq_mg_statements s WHERE s.org_id = NEW.org_id AND s.term_version_id = NEW.term_version_id AND s.close_month = NEW.close_month AND s.kind = 'issue' AND NOT EXISTS (SELECT 1 FROM acq_mg_statements v WHERE v.org_id = s.org_id AND v.voids_statement_id = s.id))) IS NOT TRUE THEN RETURN NEW; END IF;
  RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'この締め月の報告書は発行済みです。取り消してから発行し直してください';
  RETURN NEW;
END
$fn$;
CREATE TRIGGER acq_mg_statements_one_live_issue BEFORE INSERT ON acq_mg_statements FOR EACH ROW EXECUTE FUNCTION acq_mg_statements_one_live_issue_fn();
CREATE TRIGGER acq_mg_statements_no_update BEFORE UPDATE ON acq_mg_statements FOR EACH ROW EXECUTE FUNCTION lite_reject_change('分配報告書は変更できません。取り消して発行し直してください');
CREATE TRIGGER acq_mg_statements_no_delete BEFORE DELETE ON acq_mg_statements FOR EACH ROW EXECUTE FUNCTION lite_reject_change('分配報告書は削除できません');
CREATE TABLE acq_mg_documents (
  id bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  org_id bigint NOT NULL,
  contract_id bigint NOT NULL,
  term_version_id bigint,
  source_document_id bigint NOT NULL CHECK (lite_typeof(source_document_id) = 'integer' AND source_document_id > 0),
  kind text COLLATE "C" NOT NULL CHECK (kind IN ('contract', 'payment_proof', 'invoice')),
  reason text COLLATE "C" NOT NULL CHECK (length(trim(reason)) BETWEEN 1 AND 500),
  created_by bigint NOT NULL,
  created_at text COLLATE "C" NOT NULL DEFAULT to_char(statement_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS'),
  UNIQUE (org_id, id),
  UNIQUE (org_id, contract_id, source_document_id, kind)
);
CREATE FUNCTION acq_mg_documents_version_scope_fn() RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  IF (NEW.term_version_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM acq_mg_term_versions v WHERE v.org_id = NEW.org_id AND v.id = NEW.term_version_id AND v.contract_id = NEW.contract_id)) IS NOT TRUE THEN RETURN NEW; END IF;
  RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = '原本が指す条件版は、同じ契約のものです';
  RETURN NEW;
END
$fn$;
CREATE TRIGGER acq_mg_documents_version_scope BEFORE INSERT ON acq_mg_documents FOR EACH ROW EXECUTE FUNCTION acq_mg_documents_version_scope_fn();
CREATE TRIGGER acq_mg_documents_no_update BEFORE UPDATE ON acq_mg_documents FOR EACH ROW EXECUTE FUNCTION lite_reject_change('原本の結び付きは変更できません');
CREATE TRIGGER acq_mg_documents_no_delete BEFORE DELETE ON acq_mg_documents FOR EACH ROW EXECUTE FUNCTION lite_reject_change('原本の結び付きは削除できません');

-- ===== 0027_acq_mg_payments.sql =====
CREATE TABLE acq_mg_payments (
  id bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  org_id bigint NOT NULL,
  contract_id bigint NOT NULL,
  term_version_id bigint NOT NULL,
  kind text COLLATE "C" NOT NULL CHECK (kind IN ('mg_advance', 'distribution')),
  installment bigint CHECK (installment IS NULL OR (lite_typeof(installment) = 'integer' AND installment BETWEEN 1 AND 50)),
  statement_id bigint,
  partner_id bigint NOT NULL,
  amount_yen bigint NOT NULL CHECK (lite_typeof(amount_yen) = 'integer' AND amount_yen BETWEEN 1 AND 9007199254740991),
  paid_on text COLLATE "C" NOT NULL CHECK (length(paid_on) = 10 AND paid_on BETWEEN '1900-01-01' AND '2999-12-31'),
  reference text COLLATE "C" NOT NULL CHECK (length(trim(reference)) BETWEEN 1 AND 160),
  currency text COLLATE "C" NOT NULL DEFAULT 'JPY' CHECK (length(currency) = 3 AND upper(currency) = currency),
  foreign_amount bigint CHECK (foreign_amount IS NULL OR (lite_typeof(foreign_amount) = 'integer' AND foreign_amount BETWEEN 1 AND 9007199254740991)),
  fx_rate_micro bigint CHECK (fx_rate_micro IS NULL OR (lite_typeof(fx_rate_micro) = 'integer' AND fx_rate_micro BETWEEN 1 AND 9007199254740991)),
  fx_rate_on text COLLATE "C" CHECK (fx_rate_on IS NULL OR (length(fx_rate_on) = 10 AND fx_rate_on BETWEEN '1900-01-01' AND '2999-12-31')),
  reverses_payment_id bigint,
  reason text COLLATE "C" NOT NULL CHECK (length(trim(reason)) BETWEEN 1 AND 1000),
  created_by bigint NOT NULL,
  created_at text COLLATE "C" NOT NULL DEFAULT to_char(statement_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS'),
  CHECK ((currency = 'JPY' AND foreign_amount IS NULL AND fx_rate_micro IS NULL AND fx_rate_on IS NULL) OR (currency <> 'JPY' AND foreign_amount IS NOT NULL AND fx_rate_micro IS NOT NULL AND fx_rate_on IS NOT NULL)),
  CHECK ((kind = 'mg_advance' AND statement_id IS NULL) OR (kind = 'distribution' AND installment IS NULL AND statement_id IS NOT NULL)),
  CHECK (reverses_payment_id IS NULL OR reverses_payment_id <> id),
  UNIQUE (org_id, id),
  UNIQUE (org_id, reference),
  UNIQUE (org_id, reverses_payment_id)
);
CREATE FUNCTION acq_mg_payments_version_scope_fn() RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  IF (NOT EXISTS (SELECT 1 FROM acq_mg_term_versions v WHERE v.org_id = NEW.org_id AND v.id = NEW.term_version_id AND v.contract_id = NEW.contract_id)) IS NOT TRUE THEN RETURN NEW; END IF;
  RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = '支払が指す条件版は、同じ契約のものです';
  RETURN NEW;
END
$fn$;
CREATE TRIGGER acq_mg_payments_version_scope BEFORE INSERT ON acq_mg_payments FOR EACH ROW EXECUTE FUNCTION acq_mg_payments_version_scope_fn();
CREATE FUNCTION acq_mg_payments_partner_match_fn() RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  IF (NOT EXISTS (SELECT 1 FROM acq_mg_contracts k WHERE k.org_id = NEW.org_id AND k.id = NEW.contract_id AND k.partner_id = NEW.partner_id)) IS NOT TRUE THEN RETURN NEW; END IF;
  RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = '支払の相手は、契約の権利元です';
  RETURN NEW;
END
$fn$;
CREATE TRIGGER acq_mg_payments_partner_match BEFORE INSERT ON acq_mg_payments FOR EACH ROW EXECUTE FUNCTION acq_mg_payments_partner_match_fn();
CREATE FUNCTION acq_mg_payments_installment_scope_fn() RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  IF (NEW.installment IS NOT NULL AND NOT EXISTS (SELECT 1 FROM acq_mg_payment_schedule p WHERE p.org_id = NEW.org_id AND p.term_version_id = NEW.term_version_id AND p.installment = NEW.installment)) IS NOT TRUE THEN RETURN NEW; END IF;
  RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = '支払予定に無い回です';
  RETURN NEW;
END
$fn$;
CREATE TRIGGER acq_mg_payments_installment_scope BEFORE INSERT ON acq_mg_payments FOR EACH ROW EXECUTE FUNCTION acq_mg_payments_installment_scope_fn();
CREATE FUNCTION acq_mg_payments_statement_scope_fn() RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  IF (NEW.statement_id IS NOT NULL AND NEW.reverses_payment_id IS NULL AND NOT EXISTS (SELECT 1 FROM acq_mg_statements s JOIN acq_mg_term_versions v ON v.org_id = s.org_id AND v.id = s.term_version_id WHERE s.org_id = NEW.org_id AND s.id = NEW.statement_id AND s.kind = 'issue' AND v.contract_id = NEW.contract_id AND NOT EXISTS (SELECT 1 FROM acq_mg_statements x WHERE x.org_id = s.org_id AND x.voids_statement_id = s.id))) IS NOT TRUE THEN RETURN NEW; END IF;
  RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = '分配額の支払は、同じ契約の取り消されていない報告書を指してください';
  RETURN NEW;
END
$fn$;
CREATE TRIGGER acq_mg_payments_statement_scope BEFORE INSERT ON acq_mg_payments FOR EACH ROW EXECUTE FUNCTION acq_mg_payments_statement_scope_fn();
CREATE FUNCTION acq_mg_payments_reverse_scope_fn() RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  IF (NEW.reverses_payment_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM acq_mg_payments p WHERE p.org_id = NEW.org_id AND p.id = NEW.reverses_payment_id AND p.reverses_payment_id IS NULL AND p.contract_id = NEW.contract_id AND p.kind = NEW.kind AND p.amount_yen = NEW.amount_yen AND p.partner_id = NEW.partner_id)) IS NOT TRUE THEN RETURN NEW; END IF;
  RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = '取消は、同じ契約・種類・額・相手の元の支払を指してください';
  RETURN NEW;
END
$fn$;
CREATE TRIGGER acq_mg_payments_reverse_scope BEFORE INSERT ON acq_mg_payments FOR EACH ROW EXECUTE FUNCTION acq_mg_payments_reverse_scope_fn();
CREATE TRIGGER acq_mg_payments_no_update BEFORE UPDATE ON acq_mg_payments FOR EACH ROW EXECUTE FUNCTION lite_reject_change('支払の記録は変更できません。取消の行を足してください');
CREATE TRIGGER acq_mg_payments_no_delete BEFORE DELETE ON acq_mg_payments FOR EACH ROW EXECUTE FUNCTION lite_reject_change('支払の記録は削除できません');

-- ===== 0028_budget_templates_line_items.sql =====
CREATE TABLE budget_templates (
  id bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  org_id bigint NOT NULL,
  name text COLLATE "C" NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 100),
  created_by bigint NOT NULL,
  created_at text COLLATE "C" NOT NULL DEFAULT to_char(statement_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS'),
  UNIQUE (org_id, id),
  UNIQUE (org_id, name)
);
CREATE TRIGGER budget_templates_no_update BEFORE UPDATE ON budget_templates FOR EACH ROW EXECUTE FUNCTION lite_reject_change('budget record immutable');
CREATE TRIGGER budget_templates_no_delete BEFORE DELETE ON budget_templates FOR EACH ROW EXECUTE FUNCTION lite_reject_change('budget record immutable');
CREATE INDEX budget_templates_author_idx ON budget_templates (org_id, created_by);
CREATE TABLE budget_template_versions (
  id bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  org_id bigint NOT NULL,
  template_id bigint NOT NULL,
  version_no bigint NOT NULL CHECK (lite_typeof(version_no) = 'integer' AND version_no > 0),
  source_kind text COLLATE "C" NOT NULL CHECK (source_kind IN ('file', 'budget', 'screen')),
  source_file_name text COLLATE "C" CHECK (source_file_name IS NULL OR length(trim(source_file_name)) BETWEEN 1 AND 240),
  source_project_id bigint,
  source_budget_version_id bigint,
  reason text COLLATE "C" NOT NULL CHECK (length(trim(reason)) BETWEEN 1 AND 1000),
  created_by bigint NOT NULL,
  created_at text COLLATE "C" NOT NULL DEFAULT to_char(statement_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS'),
  UNIQUE (org_id, id),
  UNIQUE (org_id, template_id, version_no),
  CHECK ((source_kind = 'file' AND source_file_name IS NOT NULL) OR (source_kind <> 'file' AND source_file_name IS NULL)),
  CHECK ((source_kind = 'budget' AND source_project_id IS NOT NULL AND source_budget_version_id IS NOT NULL) OR (source_kind <> 'budget' AND source_project_id IS NULL AND source_budget_version_id IS NULL))
);
CREATE FUNCTION budget_template_versions_sequence_fn() RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  IF (NEW.version_no <> (SELECT COALESCE(max(v.version_no), 0) + 1 FROM budget_template_versions v WHERE v.org_id = NEW.org_id AND v.template_id = NEW.template_id)) IS NOT TRUE THEN RETURN NEW; END IF;
  RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'stale budget template version';
  RETURN NEW;
END
$fn$;
CREATE TRIGGER budget_template_versions_sequence BEFORE INSERT ON budget_template_versions FOR EACH ROW EXECUTE FUNCTION budget_template_versions_sequence_fn();
CREATE TRIGGER budget_template_versions_no_update BEFORE UPDATE ON budget_template_versions FOR EACH ROW EXECUTE FUNCTION lite_reject_change('budget record immutable');
CREATE TRIGGER budget_template_versions_no_delete BEFORE DELETE ON budget_template_versions FOR EACH ROW EXECUTE FUNCTION lite_reject_change('budget record immutable');
CREATE INDEX budget_template_versions_author_idx ON budget_template_versions (org_id, created_by);
CREATE INDEX budget_template_versions_source_idx ON budget_template_versions (org_id, source_project_id, source_budget_version_id);
CREATE TABLE budget_template_items (
  id bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  org_id bigint NOT NULL,
  template_version_id bigint NOT NULL,
  category_code text COLLATE "C" NOT NULL CHECK (category_code IN ('A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J', 'K')),
  line_no bigint NOT NULL CHECK (lite_typeof(line_no) = 'integer' AND line_no BETWEEN 1 AND 1000),
  name text COLLATE "C" NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 200),
  unit text COLLATE "C" CHECK (unit IS NULL OR length(trim(unit)) BETWEEN 1 AND 20),
  unit_price_yen bigint CHECK (unit_price_yen IS NULL OR (lite_typeof(unit_price_yen) = 'integer' AND unit_price_yen BETWEEN 0 AND 1000000000000)),
  qty_milli bigint CHECK (qty_milli IS NULL OR (lite_typeof(qty_milli) = 'integer' AND qty_milli BETWEEN 0 AND 1000000000)),
  breakdown_sheet text COLLATE "C" CHECK (breakdown_sheet IS NULL OR length(trim(breakdown_sheet)) BETWEEN 1 AND 31),
  note text COLLATE "C" CHECK (note IS NULL OR length(trim(note)) BETWEEN 1 AND 500),
  UNIQUE (org_id, id),
  UNIQUE (org_id, template_version_id, category_code, line_no)
);
CREATE TRIGGER budget_template_items_no_update BEFORE UPDATE ON budget_template_items FOR EACH ROW EXECUTE FUNCTION lite_reject_change('budget record immutable');
CREATE TRIGGER budget_template_items_no_delete BEFORE DELETE ON budget_template_items FOR EACH ROW EXECUTE FUNCTION lite_reject_change('budget record immutable');
CREATE INDEX budget_template_items_version_idx ON budget_template_items (org_id, template_version_id);
CREATE TABLE budget_version_templates (
  org_id bigint NOT NULL,
  project_id bigint NOT NULL,
  version_id bigint NOT NULL,
  template_version_id bigint NOT NULL,
  PRIMARY KEY (org_id, version_id)
);
CREATE TRIGGER budget_version_templates_no_update BEFORE UPDATE ON budget_version_templates FOR EACH ROW EXECUTE FUNCTION lite_reject_change('budget record immutable');
CREATE TRIGGER budget_version_templates_no_delete BEFORE DELETE ON budget_version_templates FOR EACH ROW EXECUTE FUNCTION lite_reject_change('budget record immutable');
CREATE INDEX budget_version_templates_template_idx ON budget_version_templates (org_id, template_version_id);
CREATE TABLE budget_line_items (
  id bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  org_id bigint NOT NULL,
  project_id bigint NOT NULL,
  version_id bigint NOT NULL,
  category_code text COLLATE "C" NOT NULL CHECK (category_code IN ('A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J', 'K')),
  line_no bigint NOT NULL CHECK (lite_typeof(line_no) = 'integer' AND line_no BETWEEN 1 AND 1000),
  item_no bigint NOT NULL CHECK (lite_typeof(item_no) = 'integer' AND item_no BETWEEN 1 AND 500),
  breakdown_sheet text COLLATE "C" NOT NULL CHECK (length(trim(breakdown_sheet)) BETWEEN 1 AND 31),
  label text COLLATE "C" NOT NULL CHECK (length(trim(label)) BETWEEN 1 AND 200),
  qty_milli bigint CHECK (qty_milli IS NULL OR (lite_typeof(qty_milli) = 'integer' AND qty_milli BETWEEN 0 AND 1000000000)),
  unit_price_yen bigint CHECK (unit_price_yen IS NULL OR (lite_typeof(unit_price_yen) = 'integer' AND unit_price_yen BETWEEN 0 AND 1000000000000)),
  amount_ex_tax_yen bigint NOT NULL CHECK (lite_typeof(amount_ex_tax_yen) = 'integer' AND amount_ex_tax_yen BETWEEN 0 AND 1000000000000),
  casting_ref text COLLATE "C" CHECK (casting_ref IS NULL OR length(trim(casting_ref)) BETWEEN 1 AND 80),
  source_cell text COLLATE "C" CHECK (source_cell IS NULL OR length(source_cell) BETWEEN 2 AND 40),
  note text COLLATE "C" CHECK (note IS NULL OR length(trim(note)) BETWEEN 1 AND 500),
  UNIQUE (org_id, id),
  UNIQUE (org_id, version_id, category_code, line_no, item_no)
);
CREATE FUNCTION budget_line_items_fixed_fn() RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  IF (EXISTS (SELECT 1 FROM budget_fixes f WHERE f.org_id = NEW.org_id AND f.version_id = NEW.version_id)) IS NOT TRUE THEN RETURN NEW; END IF;
  RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'budget version already fixed';
  RETURN NEW;
END
$fn$;
CREATE TRIGGER budget_line_items_fixed BEFORE INSERT ON budget_line_items FOR EACH ROW EXECUTE FUNCTION budget_line_items_fixed_fn();
CREATE TRIGGER budget_line_items_no_update BEFORE UPDATE ON budget_line_items FOR EACH ROW EXECUTE FUNCTION lite_reject_change('budget record immutable');
CREATE TRIGGER budget_line_items_no_delete BEFORE DELETE ON budget_line_items FOR EACH ROW EXECUTE FUNCTION lite_reject_change('budget record immutable');
CREATE INDEX budget_line_items_version_idx ON budget_line_items (org_id, version_id);

-- ===== 0041_expense_folders.sql =====
CREATE TABLE expense_file_placements (
  id bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  org_id bigint NOT NULL,
  file_id bigint NOT NULL,
  placed_month text COLLATE "C" NOT NULL CHECK (length(placed_month) = 7 AND substr(placed_month, 5, 1) = '-' AND ltrim(substr(placed_month, 1, 4) || substr(placed_month, 6, 2), '0123456789') = '' AND substr(placed_month, 6, 2) BETWEEN '01' AND '12'),
  reason text COLLATE "C" NOT NULL CHECK (length(trim(reason)) BETWEEN 1 AND 1000),
  created_by bigint NOT NULL,
  created_at text COLLATE "C" NOT NULL DEFAULT to_char(statement_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS'),
  UNIQUE (org_id, id)
);
CREATE FUNCTION expense_file_placements_one_active_fn() RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  IF (EXISTS (SELECT 1 FROM expense_file_placements p WHERE p.org_id = NEW.org_id AND p.file_id = NEW.file_id AND NOT EXISTS (SELECT 1 FROM expense_file_placement_voids v WHERE v.org_id = p.org_id AND v.placement_id = p.id))) IS NOT TRUE THEN RETURN NEW; END IF;
  RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'duplicate expense file placement';
  RETURN NEW;
END
$fn$;
CREATE TRIGGER expense_file_placements_one_active BEFORE INSERT ON expense_file_placements FOR EACH ROW EXECUTE FUNCTION expense_file_placements_one_active_fn();
CREATE TRIGGER expense_file_placements_no_update BEFORE UPDATE ON expense_file_placements FOR EACH ROW EXECUTE FUNCTION lite_reject_change('expense record immutable');
CREATE TRIGGER expense_file_placements_no_delete BEFORE DELETE ON expense_file_placements FOR EACH ROW EXECUTE FUNCTION lite_reject_change('expense record immutable');
CREATE INDEX expense_file_placements_file_idx ON expense_file_placements (org_id, file_id);
CREATE INDEX expense_file_placements_month_idx ON expense_file_placements (org_id, placed_month);
CREATE INDEX expense_file_placements_author_idx ON expense_file_placements (org_id, created_by);
CREATE TABLE expense_file_placement_voids (
  org_id bigint NOT NULL,
  placement_id bigint NOT NULL,
  reason text COLLATE "C" NOT NULL CHECK (length(trim(reason)) BETWEEN 1 AND 1000),
  created_by bigint NOT NULL,
  created_at text COLLATE "C" NOT NULL DEFAULT to_char(statement_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS'),
  PRIMARY KEY (org_id, placement_id)
);
CREATE TRIGGER expense_file_placement_voids_no_update BEFORE UPDATE ON expense_file_placement_voids FOR EACH ROW EXECUTE FUNCTION lite_reject_change('expense record immutable');
CREATE TRIGGER expense_file_placement_voids_no_delete BEFORE DELETE ON expense_file_placement_voids FOR EACH ROW EXECUTE FUNCTION lite_reject_change('expense record immutable');
CREATE INDEX expense_file_placement_voids_author_idx ON expense_file_placement_voids (org_id, created_by);
CREATE TABLE expense_month_closures (
  id bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  org_id bigint NOT NULL,
  month text COLLATE "C" NOT NULL CHECK (length(month) = 7 AND substr(month, 5, 1) = '-' AND ltrim(substr(month, 1, 4) || substr(month, 6, 2), '0123456789') = '' AND substr(month, 6, 2) BETWEEN '01' AND '12'),
  kind text COLLATE "C" NOT NULL CHECK (kind IN ('close', 'reopen')),
  file_count bigint NOT NULL CHECK (lite_typeof(file_count) = 'integer' AND file_count >= 0),
  reason text COLLATE "C" NOT NULL CHECK (length(trim(reason)) BETWEEN 1 AND 1000),
  created_by bigint NOT NULL,
  created_at text COLLATE "C" NOT NULL DEFAULT to_char(statement_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS'),
  UNIQUE (org_id, id)
);
CREATE TRIGGER expense_month_closures_no_update BEFORE UPDATE ON expense_month_closures FOR EACH ROW EXECUTE FUNCTION lite_reject_change('expense record immutable');
CREATE TRIGGER expense_month_closures_no_delete BEFORE DELETE ON expense_month_closures FOR EACH ROW EXECUTE FUNCTION lite_reject_change('expense record immutable');
CREATE INDEX expense_month_closures_month_idx ON expense_month_closures (org_id, month);
CREATE INDEX expense_month_closures_author_idx ON expense_month_closures (org_id, created_by);

-- ===== 0042_committee_terms_formula.sql =====
CREATE TABLE committee_term_templates (
  id bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  org_id bigint NOT NULL,
  code text COLLATE "C" NOT NULL CHECK (length(trim(code)) BETWEEN 1 AND 60),
  version_no bigint NOT NULL CHECK (lite_typeof(version_no) = 'integer' AND version_no > 0),
  previous_id bigint,
  name text COLLATE "C" NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 200),
  body_json text COLLATE "C" NOT NULL CHECK (length(body_json) BETWEEN 2 AND 200000),
  reason text COLLATE "C" NOT NULL CHECK (length(trim(reason)) BETWEEN 1 AND 1000),
  created_by bigint NOT NULL,
  created_at text COLLATE "C" NOT NULL DEFAULT to_char(statement_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS'),
  UNIQUE (org_id, id),
  UNIQUE (org_id, code, version_no),
  CHECK ((version_no = 1 AND previous_id IS NULL) OR (version_no > 1 AND previous_id IS NOT NULL))
);
CREATE FUNCTION committee_term_templates_sequence_fn() RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  IF (NEW.version_no <> (SELECT COALESCE(max(t.version_no), 0) + 1 FROM committee_term_templates t WHERE t.org_id = NEW.org_id AND t.code = NEW.code)) IS NOT TRUE THEN RETURN NEW; END IF;
  RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'stale committee template version';
  RETURN NEW;
END
$fn$;
CREATE TRIGGER committee_term_templates_sequence BEFORE INSERT ON committee_term_templates FOR EACH ROW EXECUTE FUNCTION committee_term_templates_sequence_fn();
CREATE FUNCTION committee_term_templates_previous_fn() RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  IF (NEW.previous_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM committee_term_templates t WHERE t.org_id = NEW.org_id AND t.id = NEW.previous_id AND t.code = NEW.code AND t.version_no = NEW.version_no - 1)) IS NOT TRUE THEN RETURN NEW; END IF;
  RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'committee template previous version mismatch';
  RETURN NEW;
END
$fn$;
CREATE TRIGGER committee_term_templates_previous BEFORE INSERT ON committee_term_templates FOR EACH ROW EXECUTE FUNCTION committee_term_templates_previous_fn();
CREATE TRIGGER committee_term_templates_no_update BEFORE UPDATE ON committee_term_templates FOR EACH ROW EXECUTE FUNCTION lite_reject_change('committee template immutable');
CREATE TRIGGER committee_term_templates_no_delete BEFORE DELETE ON committee_term_templates FOR EACH ROW EXECUTE FUNCTION lite_reject_change('committee template immutable');
CREATE TABLE committee_term_version_templates (
  org_id bigint NOT NULL,
  term_version_id bigint NOT NULL,
  template_id bigint NOT NULL,
  created_by bigint NOT NULL,
  created_at text COLLATE "C" NOT NULL DEFAULT to_char(statement_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS'),
  PRIMARY KEY (org_id, term_version_id)
);
CREATE TRIGGER committee_term_version_templates_no_update BEFORE UPDATE ON committee_term_version_templates FOR EACH ROW EXECUTE FUNCTION lite_reject_change('committee term template link immutable');
CREATE TRIGGER committee_term_version_templates_no_delete BEFORE DELETE ON committee_term_version_templates FOR EACH ROW EXECUTE FUNCTION lite_reject_change('committee term template link immutable');
CREATE TABLE committee_term_businesses (
  org_id bigint NOT NULL,
  term_version_id bigint NOT NULL,
  business_code text COLLATE "C" NOT NULL CHECK (business_code IN ('theatrical', 'program', 'non_theatrical', 'home_video', 'commercial_video', 'internet', 'tv', 'ancillary', 'publishing', 'merchandising', 'overseas', 'music_master', 'music_publishing', 'other')),
  display_order bigint NOT NULL CHECK (lite_typeof(display_order) = 'integer' AND display_order BETWEEN 1 AND 100),
  operator_partner_id bigint NOT NULL,
  clause_reference text COLLATE "C" CHECK (clause_reference IS NULL OR length(trim(clause_reference)) BETWEEN 1 AND 200),
  created_by bigint NOT NULL,
  created_at text COLLATE "C" NOT NULL DEFAULT to_char(statement_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS'),
  PRIMARY KEY (org_id, term_version_id, business_code),
  UNIQUE (org_id, term_version_id, display_order)
);
CREATE TRIGGER committee_term_businesses_no_update BEFORE UPDATE ON committee_term_businesses FOR EACH ROW EXECUTE FUNCTION lite_reject_change('committee business terms immutable');
CREATE TRIGGER committee_term_businesses_no_delete BEFORE DELETE ON committee_term_businesses FOR EACH ROW EXECUTE FUNCTION lite_reject_change('committee business terms immutable');
CREATE TABLE committee_term_business_steps (
  org_id bigint NOT NULL,
  term_version_id bigint NOT NULL,
  business_code text COLLATE "C" NOT NULL,
  step_no bigint NOT NULL CHECK (lite_typeof(step_no) = 'integer' AND step_no BETWEEN 1 AND 50),
  kind text COLLATE "C" NOT NULL CHECK (kind IN ('expense', 'secondary_royalty', 'agent_fee')),
  expense_label text COLLATE "C" CHECK (expense_label IS NULL OR length(trim(expense_label)) BETWEEN 1 AND 100),
  holder_role text COLLATE "C" CHECK (holder_role IS NULL OR holder_role IN ('original', 'director', 'screenplay', 'music', 'other')),
  deduct_expenses bigint CHECK (deduct_expenses IS NULL OR deduct_expenses IN (0, 1)),
  fee_rate_bps bigint CHECK (fee_rate_bps IS NULL OR (lite_typeof(fee_rate_bps) = 'integer' AND fee_rate_bps BETWEEN 0 AND 10000)),
  fee_base text COLLATE "C" CHECK (fee_base IS NULL OR fee_base IN ('income', 'remaining')),
  created_by bigint NOT NULL,
  created_at text COLLATE "C" NOT NULL DEFAULT to_char(statement_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS'),
  PRIMARY KEY (org_id, term_version_id, business_code, step_no),
  CHECK ((kind = 'expense' AND expense_label IS NOT NULL AND holder_role IS NULL AND deduct_expenses IS NULL AND fee_rate_bps IS NULL AND fee_base IS NULL) OR (kind = 'secondary_royalty' AND holder_role IS NOT NULL AND deduct_expenses IS NOT NULL AND expense_label IS NULL AND fee_rate_bps IS NULL AND fee_base IS NULL) OR (kind = 'agent_fee' AND fee_rate_bps IS NOT NULL AND fee_base IS NOT NULL AND expense_label IS NULL AND holder_role IS NULL AND deduct_expenses IS NULL))
);
CREATE TRIGGER committee_term_business_steps_no_update BEFORE UPDATE ON committee_term_business_steps FOR EACH ROW EXECUTE FUNCTION lite_reject_change('committee business steps immutable');
CREATE TRIGGER committee_term_business_steps_no_delete BEFORE DELETE ON committee_term_business_steps FOR EACH ROW EXECUTE FUNCTION lite_reject_change('committee business steps immutable');
CREATE TABLE committee_term_committee_steps (
  org_id bigint NOT NULL,
  term_version_id bigint NOT NULL,
  step_no bigint NOT NULL CHECK (lite_typeof(step_no) = 'integer' AND step_no BETWEEN 1 AND 50),
  kind text COLLATE "C" NOT NULL CHECK (kind IN ('overhead', 'manager_fee', 'success_fee')),
  overhead_label text COLLATE "C" CHECK (overhead_label IS NULL OR length(trim(overhead_label)) BETWEEN 1 AND 100),
  recipient_partner_id bigint,
  rate_bps bigint CHECK (rate_bps IS NULL OR (lite_typeof(rate_bps) = 'integer' AND rate_bps BETWEEN 0 AND 10000)),
  fee_base text COLLATE "C" CHECK (fee_base IS NULL OR fee_base IN ('a', 'remaining')),
  threshold_kind text COLLATE "C" CHECK (threshold_kind IS NULL OR threshold_kind IN ('total_budget', 'investment_total')),
  success_mode text COLLATE "C" CHECK (success_mode IS NULL OR success_mode IN ('excess', 'after_recoup')),
  crossing_rule text COLLATE "C" CHECK (crossing_rule IS NULL OR crossing_rule IN ('whole_period', 'excess_part')),
  created_by bigint NOT NULL,
  created_at text COLLATE "C" NOT NULL DEFAULT to_char(statement_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS'),
  PRIMARY KEY (org_id, term_version_id, step_no),
  CHECK ((kind = 'overhead' AND overhead_label IS NOT NULL AND recipient_partner_id IS NULL AND rate_bps IS NULL AND fee_base IS NULL AND threshold_kind IS NULL AND success_mode IS NULL AND crossing_rule IS NULL) OR (kind = 'manager_fee' AND recipient_partner_id IS NOT NULL AND rate_bps IS NOT NULL AND fee_base IS NOT NULL AND overhead_label IS NULL AND threshold_kind IS NULL AND success_mode IS NULL AND crossing_rule IS NULL) OR (kind = 'success_fee' AND recipient_partner_id IS NOT NULL AND rate_bps IS NOT NULL AND threshold_kind IS NOT NULL AND success_mode IS NOT NULL AND overhead_label IS NULL AND fee_base IS NULL AND ((success_mode = 'excess' AND crossing_rule IS NULL) OR (success_mode = 'after_recoup' AND crossing_rule IS NOT NULL))))
);
CREATE TRIGGER committee_term_committee_steps_no_update BEFORE UPDATE ON committee_term_committee_steps FOR EACH ROW EXECUTE FUNCTION lite_reject_change('committee steps immutable');
CREATE TRIGGER committee_term_committee_steps_no_delete BEFORE DELETE ON committee_term_committee_steps FOR EACH ROW EXECUTE FUNCTION lite_reject_change('committee steps immutable');
CREATE TABLE committee_term_budget_lines (
  org_id bigint NOT NULL,
  term_version_id bigint NOT NULL,
  line_no bigint NOT NULL CHECK (lite_typeof(line_no) = 'integer' AND line_no BETWEEN 1 AND 50),
  item text COLLATE "C" NOT NULL CHECK (item IN ('production', 'pa', 'contingency', 'other')),
  label text COLLATE "C" CHECK (label IS NULL OR length(trim(label)) BETWEEN 1 AND 100),
  amount_yen bigint NOT NULL CHECK (lite_typeof(amount_yen) = 'integer' AND amount_yen BETWEEN 0 AND 1000000000000),
  tax_basis text COLLATE "C" NOT NULL CHECK (tax_basis IN ('ex_tax', 'inc_tax')),
  created_by bigint NOT NULL,
  created_at text COLLATE "C" NOT NULL DEFAULT to_char(statement_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS'),
  PRIMARY KEY (org_id, term_version_id, line_no),
  CHECK (item <> 'other' OR label IS NOT NULL)
);
CREATE TRIGGER committee_term_budget_lines_no_update BEFORE UPDATE ON committee_term_budget_lines FOR EACH ROW EXECUTE FUNCTION lite_reject_change('committee budget lines immutable');
CREATE TRIGGER committee_term_budget_lines_no_delete BEFORE DELETE ON committee_term_budget_lines FOR EACH ROW EXECUTE FUNCTION lite_reject_change('committee budget lines immutable');

-- ===== 0043_committee_schedule_versions.sql =====
CREATE TABLE committee_schedule_versions (
  id bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  org_id bigint NOT NULL,
  contract_id bigint NOT NULL,
  version_no bigint NOT NULL CHECK (lite_typeof(version_no) = 'integer' AND version_no > 0),
  effective_from text COLLATE "C" NOT NULL CHECK (length(effective_from) = 10 AND substr(effective_from, 5, 1) = '-' AND substr(effective_from, 8, 1) = '-' AND ltrim(substr(effective_from, 1, 4) || substr(effective_from, 6, 2) || substr(effective_from, 9, 2), '0123456789') = '' AND substr(effective_from, 6, 2) BETWEEN '01' AND '12' AND substr(effective_from, 9, 2) BETWEEN '01' AND '31'),
  base_kind text COLLATE "C" NOT NULL CHECK (base_kind IN ('release', 'first_sales', 'contract', 'other')),
  base_date text COLLATE "C" NOT NULL CHECK (length(base_date) = 10 AND substr(base_date, 5, 1) = '-' AND substr(base_date, 8, 1) = '-' AND ltrim(substr(base_date, 1, 4) || substr(base_date, 6, 2) || substr(base_date, 9, 2), '0123456789') = '' AND substr(base_date, 6, 2) BETWEEN '01' AND '12' AND substr(base_date, 9, 2) BETWEEN '01' AND '31'),
  reason text COLLATE "C" NOT NULL CHECK (length(trim(reason)) BETWEEN 1 AND 1000),
  source_reference text COLLATE "C" CHECK (source_reference IS NULL OR length(trim(source_reference)) BETWEEN 1 AND 500),
  created_by bigint NOT NULL,
  created_at text COLLATE "C" NOT NULL DEFAULT to_char(statement_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS'),
  UNIQUE (org_id, id),
  UNIQUE (org_id, contract_id, version_no)
);
CREATE FUNCTION committee_schedule_versions_sequence_fn() RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  IF (NEW.version_no <> (SELECT COALESCE(max(v.version_no), 0) + 1 FROM committee_schedule_versions v WHERE v.org_id = NEW.org_id AND v.contract_id = NEW.contract_id)) IS NOT TRUE THEN RETURN NEW; END IF;
  RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'stale committee schedule version';
  RETURN NEW;
END
$fn$;
CREATE TRIGGER committee_schedule_versions_sequence BEFORE INSERT ON committee_schedule_versions FOR EACH ROW EXECUTE FUNCTION committee_schedule_versions_sequence_fn();
CREATE TRIGGER committee_schedule_versions_no_update BEFORE UPDATE ON committee_schedule_versions FOR EACH ROW EXECUTE FUNCTION lite_reject_change('committee schedule immutable');
CREATE TRIGGER committee_schedule_versions_no_delete BEFORE DELETE ON committee_schedule_versions FOR EACH ROW EXECUTE FUNCTION lite_reject_change('committee schedule immutable');
CREATE TABLE committee_schedule_version_phases (
  org_id bigint NOT NULL,
  schedule_version_id bigint NOT NULL,
  phase_no bigint NOT NULL CHECK (lite_typeof(phase_no) = 'integer' AND phase_no BETWEEN 1 AND 20),
  tier text COLLATE "C" NOT NULL CHECK (tier IN ('to_manager', 'to_members')),
  from_year bigint NOT NULL CHECK (lite_typeof(from_year) = 'integer' AND from_year BETWEEN 1 AND 100),
  to_year bigint CHECK (to_year IS NULL OR (lite_typeof(to_year) = 'integer' AND to_year BETWEEN 1 AND 100)),
  close_months text COLLATE "C" NOT NULL CHECK (length(close_months) = 12 AND ltrim(close_months, '01') = '' AND close_months <> '000000000000'),
  report_offset_months bigint NOT NULL CHECK (lite_typeof(report_offset_months) = 'integer' AND report_offset_months BETWEEN 0 AND 24),
  pay_from text COLLATE "C" NOT NULL CHECK (pay_from IN ('close', 'report')),
  pay_offset_months bigint NOT NULL CHECK (lite_typeof(pay_offset_months) = 'integer' AND pay_offset_months BETWEEN 0 AND 24),
  carry_under_yen bigint CHECK (carry_under_yen IS NULL OR (lite_typeof(carry_under_yen) = 'integer' AND carry_under_yen BETWEEN 0 AND 100000000)),
  holiday_rule text COLLATE "C" NOT NULL CHECK (holiday_rule IN ('previous_business_day', 'none')),
  created_by bigint NOT NULL,
  created_at text COLLATE "C" NOT NULL DEFAULT to_char(statement_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS'),
  PRIMARY KEY (org_id, schedule_version_id, phase_no),
  CHECK (to_year IS NULL OR to_year >= from_year)
);
CREATE TRIGGER committee_schedule_version_phases_no_update BEFORE UPDATE ON committee_schedule_version_phases FOR EACH ROW EXECUTE FUNCTION lite_reject_change('committee schedule immutable');
CREATE TRIGGER committee_schedule_version_phases_no_delete BEFORE DELETE ON committee_schedule_version_phases FOR EACH ROW EXECUTE FUNCTION lite_reject_change('committee schedule immutable');
CREATE TABLE committee_round_overrides (
  id bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  org_id bigint NOT NULL,
  contract_id bigint NOT NULL,
  tier text COLLATE "C" NOT NULL CHECK (tier IN ('to_manager', 'to_members')),
  close_on text COLLATE "C" NOT NULL CHECK (length(close_on) = 10 AND substr(close_on, 5, 1) = '-' AND substr(close_on, 8, 1) = '-' AND ltrim(substr(close_on, 1, 4) || substr(close_on, 6, 2) || substr(close_on, 9, 2), '0123456789') = ''),
  field text COLLATE "C" NOT NULL CHECK (field IN ('report_on', 'pay_on', 'skip')),
  value_on text COLLATE "C" CHECK (value_on IS NULL OR (length(value_on) = 10 AND substr(value_on, 5, 1) = '-' AND substr(value_on, 8, 1) = '-' AND ltrim(substr(value_on, 1, 4) || substr(value_on, 6, 2) || substr(value_on, 9, 2), '0123456789') = '')),
  reason text COLLATE "C" NOT NULL CHECK (length(trim(reason)) BETWEEN 1 AND 1000),
  source_reference text COLLATE "C" CHECK (source_reference IS NULL OR length(trim(source_reference)) BETWEEN 1 AND 500),
  created_by bigint NOT NULL,
  created_at text COLLATE "C" NOT NULL DEFAULT to_char(statement_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS'),
  UNIQUE (org_id, id),
  CHECK ((field = 'skip' AND value_on IS NULL) OR (field <> 'skip' AND value_on IS NOT NULL))
);
CREATE TRIGGER committee_round_overrides_no_update BEFORE UPDATE ON committee_round_overrides FOR EACH ROW EXECUTE FUNCTION lite_reject_change('committee round override immutable');
CREATE TRIGGER committee_round_overrides_no_delete BEFORE DELETE ON committee_round_overrides FOR EACH ROW EXECUTE FUNCTION lite_reject_change('committee round override immutable');
CREATE INDEX committee_round_overrides_round_idx ON committee_round_overrides (org_id, contract_id, tier, close_on);

-- ===== 0044_committee_ledger_entries.sql =====
CREATE TABLE committee_ledger_entries (
  id bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  org_id bigint NOT NULL,
  contract_id bigint NOT NULL,
  tier text COLLATE "C" NOT NULL CHECK (tier IN ('to_manager', 'to_members')),
  close_on text COLLATE "C" NOT NULL CHECK (length(close_on) = 10 AND substr(close_on, 5, 1) = '-' AND substr(close_on, 8, 1) = '-' AND ltrim(substr(close_on, 1, 4) || substr(close_on, 6, 2) || substr(close_on, 9, 2), '0123456789') = '' AND substr(close_on, 6, 2) BETWEEN '01' AND '12' AND substr(close_on, 9, 2) BETWEEN '01' AND '31'),
  business_code text COLLATE "C" CHECK (business_code IS NULL OR business_code IN ('theatrical', 'program', 'non_theatrical', 'home_video', 'commercial_video', 'internet', 'tv', 'ancillary', 'publishing', 'merchandising', 'overseas', 'music_master', 'music_publishing', 'other')),
  section text COLLATE "C" NOT NULL CHECK (section IN ('income', 'expense', 'secondary_royalty', 'agent_fee', 'other_income', 'overhead', 'manager_fee', 'success_fee', 'member_distribution')),
  item text COLLATE "C" CHECK (item IS NULL OR length(trim(item)) BETWEEN 1 AND 200),
  counterparty_partner_id bigint,
  holder_role text COLLATE "C" CHECK (holder_role IS NULL OR holder_role IN ('original', 'director', 'screenplay', 'music', 'other')),
  amount_yen bigint NOT NULL CHECK (lite_typeof(amount_yen) = 'integer' AND amount_yen BETWEEN - 9007199254740991 AND 9007199254740991),
  source_kind text COLLATE "C" NOT NULL CHECK (source_kind IN ('computed', 'received', 'manual')),
  source_reference text COLLATE "C" CHECK (source_reference IS NULL OR length(trim(source_reference)) BETWEEN 1 AND 200),
  reverses_id bigint,
  reason text COLLATE "C" CHECK (reason IS NULL OR length(trim(reason)) BETWEEN 1 AND 1000),
  created_by bigint NOT NULL,
  created_at text COLLATE "C" NOT NULL DEFAULT to_char(statement_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS'),
  UNIQUE (org_id, id),
  CHECK ((section IN ('income', 'expense', 'secondary_royalty', 'agent_fee') AND business_code IS NOT NULL) OR (section NOT IN ('income', 'expense', 'secondary_royalty', 'agent_fee') AND business_code IS NULL)),
  CHECK (holder_role IS NULL OR section = 'secondary_royalty'),
  CHECK (section <> 'member_distribution' OR counterparty_partner_id IS NOT NULL),
  CHECK ((reverses_id IS NULL AND reason IS NULL) OR (reverses_id IS NOT NULL AND reason IS NOT NULL AND reverses_id <> id))
);
CREATE FUNCTION committee_ledger_entries_reversal_fn() RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  IF (NEW.reverses_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM committee_ledger_entries o WHERE o.org_id = NEW.org_id AND o.id = NEW.reverses_id AND o.reverses_id IS NULL AND o.contract_id = NEW.contract_id AND o.tier = NEW.tier AND o.close_on = NEW.close_on AND COALESCE(o.business_code, '') = COALESCE(NEW.business_code, '') AND o.section = NEW.section AND COALESCE(o.counterparty_partner_id, 0) = COALESCE(NEW.counterparty_partner_id, 0) AND COALESCE(o.holder_role, '') = COALESCE(NEW.holder_role, '') AND o.amount_yen = - NEW.amount_yen)) IS NOT TRUE THEN RETURN NEW; END IF;
  RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'committee ledger reversal mismatch';
  RETURN NEW;
END
$fn$;
CREATE TRIGGER committee_ledger_entries_reversal BEFORE INSERT ON committee_ledger_entries FOR EACH ROW EXECUTE FUNCTION committee_ledger_entries_reversal_fn();
CREATE FUNCTION committee_ledger_entries_reverse_once_fn() RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  IF (NEW.reverses_id IS NOT NULL AND EXISTS (SELECT 1 FROM committee_ledger_entries r WHERE r.org_id = NEW.org_id AND r.reverses_id = NEW.reverses_id)) IS NOT TRUE THEN RETURN NEW; END IF;
  RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'committee ledger entry already reversed';
  RETURN NEW;
END
$fn$;
CREATE TRIGGER committee_ledger_entries_reverse_once BEFORE INSERT ON committee_ledger_entries FOR EACH ROW EXECUTE FUNCTION committee_ledger_entries_reverse_once_fn();
CREATE TRIGGER committee_ledger_entries_no_update BEFORE UPDATE ON committee_ledger_entries FOR EACH ROW EXECUTE FUNCTION lite_reject_change('committee ledger immutable');
CREATE TRIGGER committee_ledger_entries_no_delete BEFORE DELETE ON committee_ledger_entries FOR EACH ROW EXECUTE FUNCTION lite_reject_change('committee ledger immutable');
CREATE INDEX committee_ledger_entries_round_idx ON committee_ledger_entries (org_id, contract_id, tier, close_on);
CREATE INDEX committee_ledger_entries_party_idx ON committee_ledger_entries (org_id, counterparty_partner_id, section);

-- ===== 0045_cashbook.sql =====
CREATE TABLE bank_accounts (
  id bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  org_id bigint NOT NULL,
  label text COLLATE "C" NOT NULL CHECK (length(trim(label)) BETWEEN 1 AND 60),
  bank_name text COLLATE "C" CHECK (bank_name IS NULL OR length(trim(bank_name)) BETWEEN 1 AND 60),
  last4 text COLLATE "C" CHECK (last4 IS NULL OR (length(last4) = 4 AND ltrim(last4, '0123456789') = '')),
  gl_account_id bigint NOT NULL,
  opened_on text COLLATE "C" NOT NULL CHECK (length(opened_on) = 10 AND substr(opened_on, 5, 1) = '-' AND substr(opened_on, 8, 1) = '-' AND ltrim(substr(opened_on, 1, 4) || substr(opened_on, 6, 2) || substr(opened_on, 9, 2), '0123456789') = ''),
  created_by bigint NOT NULL,
  created_at text COLLATE "C" NOT NULL DEFAULT to_char(statement_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS'),
  UNIQUE (org_id, id),
  UNIQUE (org_id, label)
);
CREATE TRIGGER bank_accounts_no_update BEFORE UPDATE ON bank_accounts FOR EACH ROW EXECUTE FUNCTION lite_reject_change('bank account immutable');
CREATE TRIGGER bank_accounts_no_delete BEFORE DELETE ON bank_accounts FOR EACH ROW EXECUTE FUNCTION lite_reject_change('bank account immutable');
CREATE INDEX bank_accounts_gl_idx ON bank_accounts (org_id, gl_account_id);
CREATE INDEX bank_accounts_author_idx ON bank_accounts (org_id, created_by);
CREATE TABLE bank_statement_imports (
  id bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  org_id bigint NOT NULL,
  bank_account_id bigint NOT NULL,
  raw_sha256 text COLLATE "C" NOT NULL CHECK (length(raw_sha256) = 64 AND ltrim(raw_sha256, '0123456789abcdef') = ''),
  file_name text COLLATE "C" NOT NULL CHECK (length(trim(file_name)) BETWEEN 1 AND 240),
  parser text COLLATE "C" NOT NULL CHECK (length(trim(parser)) BETWEEN 1 AND 60),
  original_text text COLLATE "C" NOT NULL CHECK (length(original_text) BETWEEN 1 AND 4000000),
  line_count bigint NOT NULL CHECK (lite_typeof(line_count) = 'integer' AND line_count BETWEEN 0 AND 100000),
  new_line_count bigint NOT NULL CHECK (lite_typeof(new_line_count) = 'integer' AND new_line_count BETWEEN 0 AND line_count),
  created_by bigint NOT NULL,
  created_at text COLLATE "C" NOT NULL DEFAULT to_char(statement_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS'),
  UNIQUE (org_id, id),
  UNIQUE (org_id, raw_sha256),
  UNIQUE (org_id, bank_account_id, id)
);
CREATE TRIGGER bank_statement_imports_no_update BEFORE UPDATE ON bank_statement_imports FOR EACH ROW EXECUTE FUNCTION lite_reject_change('bank statement immutable');
CREATE TRIGGER bank_statement_imports_no_delete BEFORE DELETE ON bank_statement_imports FOR EACH ROW EXECUTE FUNCTION lite_reject_change('bank statement immutable');
CREATE INDEX bank_statement_imports_author_idx ON bank_statement_imports (org_id, created_by);
CREATE TABLE bank_statement_lines (
  id bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  org_id bigint NOT NULL,
  bank_account_id bigint NOT NULL,
  import_id bigint NOT NULL,
  line_no bigint NOT NULL CHECK (lite_typeof(line_no) = 'integer' AND line_no BETWEEN 1 AND 100000),
  value_date text COLLATE "C" NOT NULL CHECK (length(value_date) = 10 AND substr(value_date, 5, 1) = '-' AND substr(value_date, 8, 1) = '-' AND ltrim(substr(value_date, 1, 4) || substr(value_date, 6, 2) || substr(value_date, 9, 2), '0123456789') = ''),
  direction text COLLATE "C" NOT NULL CHECK (direction IN ('in', 'out')),
  amount_yen bigint NOT NULL CHECK (lite_typeof(amount_yen) = 'integer' AND amount_yen BETWEEN 1 AND 1000000000000),
  balance_after_yen bigint CHECK (balance_after_yen IS NULL OR (lite_typeof(balance_after_yen) = 'integer' AND balance_after_yen BETWEEN - 1000000000000 AND 1000000000000)),
  description text COLLATE "C" CHECK (description IS NULL OR length(description) BETWEEN 1 AND 300),
  dedupe_key text COLLATE "C" NOT NULL CHECK (length(dedupe_key) BETWEEN 1 AND 200),
  UNIQUE (org_id, id),
  UNIQUE (org_id, bank_account_id, dedupe_key),
  UNIQUE (org_id, bank_account_id, id)
);
CREATE TRIGGER bank_statement_lines_no_update BEFORE UPDATE ON bank_statement_lines FOR EACH ROW EXECUTE FUNCTION lite_reject_change('bank statement immutable');
CREATE TRIGGER bank_statement_lines_no_delete BEFORE DELETE ON bank_statement_lines FOR EACH ROW EXECUTE FUNCTION lite_reject_change('bank statement immutable');
CREATE INDEX bank_statement_lines_by_date ON bank_statement_lines (org_id, bank_account_id, value_date);
CREATE TABLE journal_entries (
  id bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  org_id bigint NOT NULL,
  entry_date text COLLATE "C" NOT NULL CHECK (length(entry_date) = 10 AND substr(entry_date, 5, 1) = '-' AND substr(entry_date, 8, 1) = '-' AND ltrim(substr(entry_date, 1, 4) || substr(entry_date, 6, 2) || substr(entry_date, 9, 2), '0123456789') = ''),
  source_kind text COLLATE "C" NOT NULL CHECK (source_kind IN ('opening', 'bank_line', 'manual')),
  bank_statement_line_id bigint,
  reverses_entry_id bigint,
  line_count bigint NOT NULL CHECK (lite_typeof(line_count) = 'integer' AND line_count BETWEEN 2 AND 50),
  memo text COLLATE "C" CHECK (memo IS NULL OR length(memo) BETWEEN 1 AND 300),
  created_by bigint NOT NULL,
  created_at text COLLATE "C" NOT NULL DEFAULT to_char(statement_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS'),
  UNIQUE (org_id, id),
  CHECK ((source_kind = 'bank_line' AND bank_statement_line_id IS NOT NULL) OR (source_kind <> 'bank_line' AND bank_statement_line_id IS NULL)),
  CHECK (reverses_entry_id IS NULL OR reverses_entry_id <> id)
);
CREATE UNIQUE INDEX journal_entries_one_reversal ON journal_entries (org_id, reverses_entry_id) WHERE reverses_entry_id IS NOT NULL;
CREATE INDEX journal_entries_by_line ON journal_entries (org_id, bank_statement_line_id);
CREATE INDEX journal_entries_by_date ON journal_entries (org_id, entry_date);
CREATE INDEX journal_entries_author_idx ON journal_entries (org_id, created_by);
CREATE TRIGGER journal_entries_no_update BEFORE UPDATE ON journal_entries FOR EACH ROW EXECUTE FUNCTION lite_reject_change('journal immutable');
CREATE TRIGGER journal_entries_no_delete BEFORE DELETE ON journal_entries FOR EACH ROW EXECUTE FUNCTION lite_reject_change('journal immutable');
CREATE FUNCTION journal_entries_reversal_scope_fn() RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  IF (NEW.reverses_entry_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM journal_entries e WHERE e.org_id = NEW.org_id AND e.id = NEW.reverses_entry_id AND e.reverses_entry_id IS NULL AND e.source_kind = NEW.source_kind AND COALESCE(e.bank_statement_line_id, 0) = COALESCE(NEW.bank_statement_line_id, 0))) IS NOT TRUE THEN RETURN NEW; END IF;
  RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'journal reversal must match the original';
  RETURN NEW;
END
$fn$;
CREATE TRIGGER journal_entries_reversal_scope BEFORE INSERT ON journal_entries FOR EACH ROW EXECUTE FUNCTION journal_entries_reversal_scope_fn();
CREATE FUNCTION journal_entries_one_active_per_line_fn() RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  IF (NEW.source_kind = 'bank_line' AND NEW.reverses_entry_id IS NULL AND EXISTS (SELECT 1 FROM journal_entries e WHERE e.org_id = NEW.org_id AND e.bank_statement_line_id = NEW.bank_statement_line_id AND e.reverses_entry_id IS NULL AND NOT EXISTS (SELECT 1 FROM journal_entries r WHERE r.org_id = e.org_id AND r.reverses_entry_id = e.id))) IS NOT TRUE THEN RETURN NEW; END IF;
  RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'bank line already has a journal';
  RETURN NEW;
END
$fn$;
CREATE TRIGGER journal_entries_one_active_per_line BEFORE INSERT ON journal_entries FOR EACH ROW EXECUTE FUNCTION journal_entries_one_active_per_line_fn();
CREATE TABLE journal_lines (
  id bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  org_id bigint NOT NULL,
  entry_id bigint NOT NULL,
  line_no bigint NOT NULL CHECK (lite_typeof(line_no) = 'integer' AND line_no BETWEEN 1 AND 50),
  account_id bigint NOT NULL,
  side text COLLATE "C" NOT NULL CHECK (side IN ('debit', 'credit')),
  amount_yen bigint NOT NULL CHECK (lite_typeof(amount_yen) = 'integer' AND amount_yen BETWEEN 1 AND 1000000000000),
  bank_account_id bigint,
  memo text COLLATE "C" CHECK (memo IS NULL OR length(memo) BETWEEN 1 AND 300),
  UNIQUE (org_id, id),
  UNIQUE (org_id, entry_id, line_no)
);
CREATE INDEX journal_lines_by_bank ON journal_lines (org_id, bank_account_id);
CREATE INDEX journal_lines_by_account ON journal_lines (org_id, account_id);
CREATE TRIGGER journal_lines_no_update BEFORE UPDATE ON journal_lines FOR EACH ROW EXECUTE FUNCTION lite_reject_change('journal immutable');
CREATE TRIGGER journal_lines_no_delete BEFORE DELETE ON journal_lines FOR EACH ROW EXECUTE FUNCTION lite_reject_change('journal immutable');
CREATE FUNCTION journal_lines_bank_account_scope_fn() RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  IF (NEW.bank_account_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM bank_accounts b WHERE b.org_id = NEW.org_id AND b.id = NEW.bank_account_id AND b.gl_account_id = NEW.account_id)) IS NOT TRUE THEN RETURN NEW; END IF;
  RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'journal line bank account must match its account';
  RETURN NEW;
END
$fn$;
CREATE TRIGGER journal_lines_bank_account_scope BEFORE INSERT ON journal_lines FOR EACH ROW EXECUTE FUNCTION journal_lines_bank_account_scope_fn();
CREATE FUNCTION journal_lines_count_fn() RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  IF ((SELECT COUNT(*) FROM journal_lines l WHERE l.org_id = NEW.org_id AND l.entry_id = NEW.entry_id) >= (SELECT e.line_count FROM journal_entries e WHERE e.org_id = NEW.org_id AND e.id = NEW.entry_id)) IS NOT TRUE THEN RETURN NEW; END IF;
  RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'journal has too many lines';
  RETURN NEW;
END
$fn$;
CREATE TRIGGER journal_lines_count BEFORE INSERT ON journal_lines FOR EACH ROW EXECUTE FUNCTION journal_lines_count_fn();
CREATE FUNCTION journal_lines_balanced_fn() RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  IF ((SELECT COUNT(*) FROM journal_lines l WHERE l.org_id = NEW.org_id AND l.entry_id = NEW.entry_id) = (SELECT e.line_count FROM journal_entries e WHERE e.org_id = NEW.org_id AND e.id = NEW.entry_id) AND (SELECT COALESCE(SUM(l.amount_yen), 0) FROM journal_lines l WHERE l.org_id = NEW.org_id AND l.entry_id = NEW.entry_id AND l.side = 'debit') <> (SELECT COALESCE(SUM(l.amount_yen), 0) FROM journal_lines l WHERE l.org_id = NEW.org_id AND l.entry_id = NEW.entry_id AND l.side = 'credit')) IS NOT TRUE THEN RETURN NULL; END IF;
  RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'journal debit and credit differ';
  RETURN NULL;
END
$fn$;
CREATE TRIGGER journal_lines_balanced AFTER INSERT ON journal_lines FOR EACH ROW EXECUTE FUNCTION journal_lines_balanced_fn();

-- ===== 0046_manufacturing.sql =====
CREATE TABLE mfg_products (
  id bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  org_id bigint NOT NULL,
  project_id bigint NOT NULL,
  work_id bigint NOT NULL,
  source_kind text COLLATE "C" NOT NULL CHECK (source_kind IN ('procure', 'mg_buy', 'own')),
  source_ref text COLLATE "C" CHECK (source_ref IS NULL OR length(trim(source_ref)) BETWEEN 1 AND 80),
  created_by bigint NOT NULL,
  created_at text COLLATE "C" NOT NULL DEFAULT to_char(statement_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS'),
  UNIQUE (org_id, id)
);
CREATE TRIGGER mfg_products_no_update BEFORE UPDATE ON mfg_products FOR EACH ROW EXECUTE FUNCTION lite_reject_change('manufacturing record immutable');
CREATE TRIGGER mfg_products_no_delete BEFORE DELETE ON mfg_products FOR EACH ROW EXECUTE FUNCTION lite_reject_change('manufacturing record immutable');
CREATE INDEX mfg_products_work_idx ON mfg_products (org_id, project_id, work_id);
CREATE INDEX mfg_products_author_idx ON mfg_products (org_id, created_by);
CREATE TABLE mfg_product_versions (
  id bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  org_id bigint NOT NULL,
  product_id bigint NOT NULL,
  version_no bigint NOT NULL CHECK (lite_typeof(version_no) = 'integer' AND version_no > 0),
  name text COLLATE "C" NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 200),
  channel text COLLATE "C" NOT NULL CHECK (channel IN ('sell', 'rental', 'print', 'other')),
  media text COLLATE "C" NOT NULL CHECK (media IN ('dvd', 'bd', 'print', 'other')),
  edition_label text COLLATE "C" CHECK (edition_label IS NULL OR length(trim(edition_label)) BETWEEN 1 AND 60),
  episode_from bigint CHECK (episode_from IS NULL OR (lite_typeof(episode_from) = 'integer' AND episode_from BETWEEN 1 AND 9999)),
  episode_to bigint CHECK (episode_to IS NULL OR (lite_typeof(episode_to) = 'integer' AND episode_to BETWEEN 1 AND 9999)),
  release_on text COLLATE "C" NOT NULL CHECK (length(release_on) = 10 AND substr(release_on, 5, 1) = '-' AND substr(release_on, 8, 1) = '-' AND ltrim(substr(release_on, 1, 4) || substr(release_on, 6, 2) || substr(release_on, 9, 2), '0123456789') = ''),
  schedule_rule text COLLATE "C" NOT NULL CHECK (schedule_rule IN ('day25', 'offset')),
  planned_qty bigint CHECK (planned_qty IS NULL OR (lite_typeof(planned_qty) = 'integer' AND planned_qty BETWEEN 0 AND 100000000)),
  note text COLLATE "C" CHECK (note IS NULL OR length(trim(note)) BETWEEN 1 AND 1000),
  reason text COLLATE "C" NOT NULL CHECK (length(trim(reason)) BETWEEN 1 AND 500),
  created_by bigint NOT NULL,
  created_at text COLLATE "C" NOT NULL DEFAULT to_char(statement_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS'),
  UNIQUE (org_id, id),
  UNIQUE (org_id, product_id, version_no),
  CHECK (episode_from IS NULL OR episode_to IS NULL OR episode_from <= episode_to),
  CHECK (schedule_rule <> 'day25' OR substr(release_on, 9, 2) = '25')
);
CREATE FUNCTION mfg_product_versions_sequence_fn() RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  IF (NEW.version_no <> (SELECT COALESCE(max(v.version_no), 0) + 1 FROM mfg_product_versions v WHERE v.org_id = NEW.org_id AND v.product_id = NEW.product_id)) IS NOT TRUE THEN RETURN NEW; END IF;
  RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'stale manufacturing version';
  RETURN NEW;
END
$fn$;
CREATE TRIGGER mfg_product_versions_sequence BEFORE INSERT ON mfg_product_versions FOR EACH ROW EXECUTE FUNCTION mfg_product_versions_sequence_fn();
CREATE TRIGGER mfg_product_versions_no_update BEFORE UPDATE ON mfg_product_versions FOR EACH ROW EXECUTE FUNCTION lite_reject_change('manufacturing record immutable');
CREATE TRIGGER mfg_product_versions_no_delete BEFORE DELETE ON mfg_product_versions FOR EACH ROW EXECUTE FUNCTION lite_reject_change('manufacturing record immutable');
CREATE INDEX mfg_product_versions_author_idx ON mfg_product_versions (org_id, created_by);
CREATE TABLE mfg_step_events (
  id bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  org_id bigint NOT NULL,
  product_id bigint NOT NULL,
  step_key text COLLATE "C" NOT NULL CHECK (length(trim(step_key)) BETWEEN 1 AND 40),
  kind text COLLATE "C" NOT NULL CHECK (kind IN ('requested', 'approved', 'done', 'planned', 'void')),
  on_date text COLLATE "C" CHECK (on_date IS NULL OR (length(on_date) = 10 AND substr(on_date, 5, 1) = '-' AND substr(on_date, 8, 1) = '-' AND ltrim(substr(on_date, 1, 4) || substr(on_date, 6, 2) || substr(on_date, 9, 2), '0123456789') = '')),
  voids_event_id bigint,
  note text COLLATE "C" CHECK (note IS NULL OR length(trim(note)) BETWEEN 1 AND 500),
  created_by bigint NOT NULL,
  created_at text COLLATE "C" NOT NULL DEFAULT to_char(statement_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS'),
  UNIQUE (org_id, id),
  CHECK ((kind = 'void' AND voids_event_id IS NOT NULL AND on_date IS NULL) OR (kind <> 'void' AND voids_event_id IS NULL AND on_date IS NOT NULL))
);
CREATE TRIGGER mfg_step_events_no_update BEFORE UPDATE ON mfg_step_events FOR EACH ROW EXECUTE FUNCTION lite_reject_change('manufacturing record immutable');
CREATE TRIGGER mfg_step_events_no_delete BEFORE DELETE ON mfg_step_events FOR EACH ROW EXECUTE FUNCTION lite_reject_change('manufacturing record immutable');
CREATE INDEX mfg_step_events_product_idx ON mfg_step_events (org_id, product_id);
CREATE INDEX mfg_step_events_author_idx ON mfg_step_events (org_id, created_by);
CREATE TABLE mfg_purchase_orders (
  id bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  org_id bigint NOT NULL,
  product_id bigint NOT NULL,
  po_no text COLLATE "C" NOT NULL CHECK (length(trim(po_no)) BETWEEN 1 AND 40),
  po_kind text COLLATE "C" NOT NULL CHECK (po_kind IN ('authoring', 'design', 'manufacture', 'print', 'sample')),
  partner_id bigint,
  partner_label text COLLATE "C" CHECK (partner_label IS NULL OR length(trim(partner_label)) BETWEEN 1 AND 120),
  deliver_to text COLLATE "C" CHECK (deliver_to IS NULL OR length(trim(deliver_to)) BETWEEN 1 AND 120),
  due_on text COLLATE "C" CHECK (due_on IS NULL OR (length(due_on) = 10 AND substr(due_on, 5, 1) = '-' AND substr(due_on, 8, 1) = '-' AND ltrim(substr(due_on, 1, 4) || substr(due_on, 6, 2) || substr(due_on, 9, 2), '0123456789') = '')),
  note text COLLATE "C" CHECK (note IS NULL OR length(trim(note)) BETWEEN 1 AND 1000),
  created_by bigint NOT NULL,
  created_at text COLLATE "C" NOT NULL DEFAULT to_char(statement_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS'),
  UNIQUE (org_id, id),
  UNIQUE (org_id, po_no),
  CHECK (partner_id IS NOT NULL OR partner_label IS NOT NULL)
);
CREATE TRIGGER mfg_purchase_orders_no_update BEFORE UPDATE ON mfg_purchase_orders FOR EACH ROW EXECUTE FUNCTION lite_reject_change('manufacturing record immutable');
CREATE TRIGGER mfg_purchase_orders_no_delete BEFORE DELETE ON mfg_purchase_orders FOR EACH ROW EXECUTE FUNCTION lite_reject_change('manufacturing record immutable');
CREATE INDEX mfg_purchase_orders_product_idx ON mfg_purchase_orders (org_id, product_id);
CREATE INDEX mfg_purchase_orders_partner_idx ON mfg_purchase_orders (org_id, partner_id);
CREATE INDEX mfg_purchase_orders_author_idx ON mfg_purchase_orders (org_id, created_by);
CREATE TABLE mfg_purchase_order_lines (
  id bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  org_id bigint NOT NULL,
  po_id bigint NOT NULL,
  line_no bigint NOT NULL CHECK (lite_typeof(line_no) = 'integer' AND line_no BETWEEN 1 AND 200),
  item text COLLATE "C" NOT NULL CHECK (length(trim(item)) BETWEEN 1 AND 120),
  spec text COLLATE "C" CHECK (spec IS NULL OR length(trim(spec)) BETWEEN 1 AND 500),
  qty bigint NOT NULL CHECK (lite_typeof(qty) = 'integer' AND qty BETWEEN 1 AND 100000000),
  unit_price_x100 bigint NOT NULL CHECK (lite_typeof(unit_price_x100) = 'integer' AND unit_price_x100 BETWEEN 0 AND 100000000000),
  amount_ex_tax_yen bigint NOT NULL CHECK (lite_typeof(amount_ex_tax_yen) = 'integer' AND amount_ex_tax_yen BETWEEN 0 AND 1000000000000),
  UNIQUE (org_id, id),
  UNIQUE (org_id, po_id, line_no),
  CHECK (amount_ex_tax_yen * 100 = qty * unit_price_x100)
);
CREATE TRIGGER mfg_purchase_order_lines_no_update BEFORE UPDATE ON mfg_purchase_order_lines FOR EACH ROW EXECUTE FUNCTION lite_reject_change('manufacturing record immutable');
CREATE TRIGGER mfg_purchase_order_lines_no_delete BEFORE DELETE ON mfg_purchase_order_lines FOR EACH ROW EXECUTE FUNCTION lite_reject_change('manufacturing record immutable');
CREATE TABLE mfg_po_events (
  id bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  org_id bigint NOT NULL,
  po_id bigint NOT NULL,
  kind text COLLATE "C" NOT NULL CHECK (kind IN ('quote_requested', 'quoted', 'ordered', 'invoiced', 'paid', 'void')),
  on_date text COLLATE "C" NOT NULL CHECK (length(on_date) = 10 AND substr(on_date, 5, 1) = '-' AND substr(on_date, 8, 1) = '-' AND ltrim(substr(on_date, 1, 4) || substr(on_date, 6, 2) || substr(on_date, 9, 2), '0123456789') = ''),
  amount_ex_tax_yen bigint CHECK (amount_ex_tax_yen IS NULL OR (lite_typeof(amount_ex_tax_yen) = 'integer' AND amount_ex_tax_yen BETWEEN 0 AND 1000000000000)),
  note text COLLATE "C" CHECK (note IS NULL OR length(trim(note)) BETWEEN 1 AND 500),
  created_by bigint NOT NULL,
  created_at text COLLATE "C" NOT NULL DEFAULT to_char(statement_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS'),
  UNIQUE (org_id, id),
  CHECK (kind <> 'void' OR note IS NOT NULL)
);
CREATE FUNCTION mfg_po_events_after_void_fn() RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  IF (EXISTS (SELECT 1 FROM mfg_po_events e WHERE e.org_id = NEW.org_id AND e.po_id = NEW.po_id AND e.kind = 'void')) IS NOT TRUE THEN RETURN NEW; END IF;
  RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'purchase order voided';
  RETURN NEW;
END
$fn$;
CREATE TRIGGER mfg_po_events_after_void BEFORE INSERT ON mfg_po_events FOR EACH ROW EXECUTE FUNCTION mfg_po_events_after_void_fn();
CREATE TRIGGER mfg_po_events_no_update BEFORE UPDATE ON mfg_po_events FOR EACH ROW EXECUTE FUNCTION lite_reject_change('manufacturing record immutable');
CREATE TRIGGER mfg_po_events_no_delete BEFORE DELETE ON mfg_po_events FOR EACH ROW EXECUTE FUNCTION lite_reject_change('manufacturing record immutable');
CREATE INDEX mfg_po_events_po_idx ON mfg_po_events (org_id, po_id);
CREATE INDEX mfg_po_events_author_idx ON mfg_po_events (org_id, created_by);
CREATE TABLE mfg_receipts (
  id bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  org_id bigint NOT NULL,
  po_line_id bigint NOT NULL,
  received_on text COLLATE "C" NOT NULL CHECK (length(received_on) = 10 AND substr(received_on, 5, 1) = '-' AND substr(received_on, 8, 1) = '-' AND ltrim(substr(received_on, 1, 4) || substr(received_on, 6, 2) || substr(received_on, 9, 2), '0123456789') = ''),
  qty bigint NOT NULL CHECK (lite_typeof(qty) = 'integer' AND qty BETWEEN 0 AND 100000000),
  defect_qty bigint NOT NULL DEFAULT 0 CHECK (lite_typeof(defect_qty) = 'integer' AND defect_qty BETWEEN 0 AND 100000000),
  result text COLLATE "C" NOT NULL CHECK (result IN ('pass', 'fail')),
  note text COLLATE "C" CHECK (note IS NULL OR length(trim(note)) BETWEEN 1 AND 500),
  created_by bigint NOT NULL,
  created_at text COLLATE "C" NOT NULL DEFAULT to_char(statement_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS'),
  UNIQUE (org_id, id),
  CHECK (defect_qty <= qty),
  CHECK (result <> 'fail' OR note IS NOT NULL)
);
CREATE TRIGGER mfg_receipts_no_update BEFORE UPDATE ON mfg_receipts FOR EACH ROW EXECUTE FUNCTION lite_reject_change('manufacturing record immutable');
CREATE TRIGGER mfg_receipts_no_delete BEFORE DELETE ON mfg_receipts FOR EACH ROW EXECUTE FUNCTION lite_reject_change('manufacturing record immutable');
CREATE INDEX mfg_receipts_line_idx ON mfg_receipts (org_id, po_line_id);
CREATE INDEX mfg_receipts_author_idx ON mfg_receipts (org_id, created_by);
CREATE TABLE mfg_po_expenses (
  id bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  org_id bigint NOT NULL,
  po_line_id bigint NOT NULL,
  expense_id bigint NOT NULL,
  action text COLLATE "C" NOT NULL CHECK (action IN ('link', 'unlink')),
  reason text COLLATE "C" CHECK (reason IS NULL OR length(trim(reason)) BETWEEN 1 AND 500),
  created_by bigint NOT NULL,
  created_at text COLLATE "C" NOT NULL DEFAULT to_char(statement_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS'),
  UNIQUE (org_id, id),
  CHECK (action <> 'unlink' OR reason IS NOT NULL)
);
CREATE TRIGGER mfg_po_expenses_no_update BEFORE UPDATE ON mfg_po_expenses FOR EACH ROW EXECUTE FUNCTION lite_reject_change('manufacturing record immutable');
CREATE TRIGGER mfg_po_expenses_no_delete BEFORE DELETE ON mfg_po_expenses FOR EACH ROW EXECUTE FUNCTION lite_reject_change('manufacturing record immutable');
CREATE INDEX mfg_po_expenses_line_idx ON mfg_po_expenses (org_id, po_line_id);
CREATE INDEX mfg_po_expenses_expense_idx ON mfg_po_expenses (org_id, expense_id);
CREATE INDEX mfg_po_expenses_author_idx ON mfg_po_expenses (org_id, created_by);

-- ===== 0047_produce_tasks.sql =====
CREATE TABLE produce_tasks (
  id bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  org_id bigint NOT NULL,
  project_id bigint NOT NULL,
  work_id bigint,
  task_uid bigint NOT NULL CHECK (lite_typeof(task_uid) = 'integer' AND task_uid > 0),
  version_no bigint NOT NULL CHECK (lite_typeof(version_no) = 'integer' AND version_no > 0),
  kind text COLLATE "C" NOT NULL CHECK (kind IN ('work', 'check', 'milestone')),
  phase text COLLATE "C" NOT NULL CHECK (phase IN ('script', 'prep', 'shoot', 'post', 'delivery', 'finance')),
  title text COLLATE "C" NOT NULL CHECK (length(trim(title)) BETWEEN 1 AND 120),
  role text COLLATE "C" NOT NULL CHECK (role IN ('producer', 'line_producer')),
  assignee_label text COLLATE "C" CHECK (assignee_label IS NULL OR length(trim(assignee_label)) BETWEEN 1 AND 60),
  checkers text COLLATE "C" CHECK (checkers IS NULL OR length(trim(checkers)) BETWEEN 1 AND 200),
  planned_start text COLLATE "C" NOT NULL CHECK (length(planned_start) = 10 AND substr(planned_start, 5, 1) = '-' AND substr(planned_start, 8, 1) = '-' AND ltrim(substr(planned_start, 1, 4) || substr(planned_start, 6, 2) || substr(planned_start, 9, 2), '0123456789') = ''),
  planned_end text COLLATE "C" NOT NULL CHECK (length(planned_end) = 10 AND substr(planned_end, 5, 1) = '-' AND substr(planned_end, 8, 1) = '-' AND ltrim(substr(planned_end, 1, 4) || substr(planned_end, 6, 2) || substr(planned_end, 9, 2), '0123456789') = ''),
  milestone_code text COLLATE "C" CHECK (milestone_code IS NULL OR milestone_code IN ('kikaku_go', 'crank_in', 'crank_up', 'edit_lock', 'sound_mix', 'first_print', 'final_screening', 'release', 'delivery')),
  template_label text COLLATE "C" CHECK (template_label IS NULL OR length(trim(template_label)) BETWEEN 1 AND 120),
  retired bigint NOT NULL DEFAULT 0 CHECK (retired IN (0, 1)),
  reason text COLLATE "C" CHECK (reason IS NULL OR length(trim(reason)) BETWEEN 1 AND 500),
  created_by bigint NOT NULL,
  created_at text COLLATE "C" NOT NULL DEFAULT to_char(statement_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS'),
  UNIQUE (org_id, id),
  UNIQUE (org_id, task_uid, version_no),
  CHECK (planned_end >= planned_start),
  CHECK (kind <> 'milestone' OR planned_end = planned_start),
  CHECK (version_no = 1 OR reason IS NOT NULL)
);
CREATE FUNCTION produce_tasks_sequence_fn() RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  IF (NEW.version_no <> (SELECT COALESCE(max(t.version_no), 0) + 1 FROM produce_tasks t WHERE t.org_id = NEW.org_id AND t.task_uid = NEW.task_uid)) IS NOT TRUE THEN RETURN NEW; END IF;
  RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'stale produce task';
  RETURN NEW;
END
$fn$;
CREATE TRIGGER produce_tasks_sequence BEFORE INSERT ON produce_tasks FOR EACH ROW EXECUTE FUNCTION produce_tasks_sequence_fn();
CREATE FUNCTION produce_tasks_same_project_fn() RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  IF (NEW.version_no > 1 AND NOT EXISTS (SELECT 1 FROM produce_tasks t WHERE t.org_id = NEW.org_id AND t.task_uid = NEW.task_uid AND t.version_no = 1 AND t.project_id = NEW.project_id)) IS NOT TRUE THEN RETURN NEW; END IF;
  RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'produce task project mismatch';
  RETURN NEW;
END
$fn$;
CREATE TRIGGER produce_tasks_same_project BEFORE INSERT ON produce_tasks FOR EACH ROW EXECUTE FUNCTION produce_tasks_same_project_fn();
CREATE TRIGGER produce_tasks_no_update BEFORE UPDATE ON produce_tasks FOR EACH ROW EXECUTE FUNCTION lite_reject_change('produce record immutable');
CREATE TRIGGER produce_tasks_no_delete BEFORE DELETE ON produce_tasks FOR EACH ROW EXECUTE FUNCTION lite_reject_change('produce record immutable');
CREATE INDEX produce_tasks_project_idx ON produce_tasks (org_id, project_id, task_uid);
CREATE INDEX produce_tasks_work_idx ON produce_tasks (org_id, project_id, work_id);
CREATE INDEX produce_tasks_author_idx ON produce_tasks (org_id, created_by);
CREATE TABLE produce_task_events (
  id bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  org_id bigint NOT NULL,
  project_id bigint NOT NULL,
  task_uid bigint NOT NULL CHECK (lite_typeof(task_uid) = 'integer' AND task_uid > 0),
  kind text COLLATE "C" NOT NULL CHECK (kind IN ('started', 'done', 'reopened')),
  on_date text COLLATE "C" NOT NULL CHECK (length(on_date) = 10 AND substr(on_date, 5, 1) = '-' AND substr(on_date, 8, 1) = '-' AND ltrim(substr(on_date, 1, 4) || substr(on_date, 6, 2) || substr(on_date, 9, 2), '0123456789') = ''),
  note text COLLATE "C" CHECK (note IS NULL OR length(trim(note)) BETWEEN 1 AND 500),
  created_by bigint NOT NULL,
  created_at text COLLATE "C" NOT NULL DEFAULT to_char(statement_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS'),
  UNIQUE (org_id, id)
);
CREATE FUNCTION produce_task_events_task_fn() RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  IF (NOT EXISTS (SELECT 1 FROM produce_tasks t WHERE t.org_id = NEW.org_id AND t.project_id = NEW.project_id AND t.task_uid = NEW.task_uid)) IS NOT TRUE THEN RETURN NEW; END IF;
  RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'produce task not found';
  RETURN NEW;
END
$fn$;
CREATE TRIGGER produce_task_events_task BEFORE INSERT ON produce_task_events FOR EACH ROW EXECUTE FUNCTION produce_task_events_task_fn();
CREATE TRIGGER produce_task_events_no_update BEFORE UPDATE ON produce_task_events FOR EACH ROW EXECUTE FUNCTION lite_reject_change('produce record immutable');
CREATE TRIGGER produce_task_events_no_delete BEFORE DELETE ON produce_task_events FOR EACH ROW EXECUTE FUNCTION lite_reject_change('produce record immutable');
CREATE INDEX produce_task_events_task_idx ON produce_task_events (org_id, project_id, task_uid);
CREATE INDEX produce_task_events_author_idx ON produce_task_events (org_id, created_by);
CREATE TABLE produce_task_checks (
  id bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  org_id bigint NOT NULL,
  project_id bigint NOT NULL,
  task_uid bigint NOT NULL CHECK (lite_typeof(task_uid) = 'integer' AND task_uid > 0),
  check_uid bigint NOT NULL CHECK (lite_typeof(check_uid) = 'integer' AND check_uid > 0),
  label text COLLATE "C" NOT NULL CHECK (length(trim(label)) BETWEEN 1 AND 200),
  checked bigint NOT NULL CHECK (checked IN (0, 1)),
  created_by bigint NOT NULL,
  created_at text COLLATE "C" NOT NULL DEFAULT to_char(statement_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS'),
  UNIQUE (org_id, id)
);
CREATE FUNCTION produce_task_checks_task_fn() RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  IF (NOT EXISTS (SELECT 1 FROM produce_tasks t WHERE t.org_id = NEW.org_id AND t.project_id = NEW.project_id AND t.task_uid = NEW.task_uid)) IS NOT TRUE THEN RETURN NEW; END IF;
  RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'produce task not found';
  RETURN NEW;
END
$fn$;
CREATE TRIGGER produce_task_checks_task BEFORE INSERT ON produce_task_checks FOR EACH ROW EXECUTE FUNCTION produce_task_checks_task_fn();
CREATE TRIGGER produce_task_checks_no_update BEFORE UPDATE ON produce_task_checks FOR EACH ROW EXECUTE FUNCTION lite_reject_change('produce record immutable');
CREATE TRIGGER produce_task_checks_no_delete BEFORE DELETE ON produce_task_checks FOR EACH ROW EXECUTE FUNCTION lite_reject_change('produce record immutable');
CREATE INDEX produce_task_checks_task_idx ON produce_task_checks (org_id, project_id, task_uid, check_uid);
CREATE INDEX produce_task_checks_author_idx ON produce_task_checks (org_id, created_by);
CREATE TABLE produce_task_posts (
  id bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  org_id bigint NOT NULL,
  project_id bigint NOT NULL,
  task_uid bigint NOT NULL CHECK (lite_typeof(task_uid) = 'integer' AND task_uid > 0),
  speaker_label text COLLATE "C" NOT NULL CHECK (length(trim(speaker_label)) BETWEEN 1 AND 40),
  body text COLLATE "C" NOT NULL CHECK (length(trim(body)) BETWEEN 1 AND 2000),
  created_by bigint NOT NULL,
  created_at text COLLATE "C" NOT NULL DEFAULT to_char(statement_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS'),
  UNIQUE (org_id, id)
);
CREATE FUNCTION produce_task_posts_task_fn() RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  IF (NOT EXISTS (SELECT 1 FROM produce_tasks t WHERE t.org_id = NEW.org_id AND t.project_id = NEW.project_id AND t.task_uid = NEW.task_uid)) IS NOT TRUE THEN RETURN NEW; END IF;
  RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'produce task not found';
  RETURN NEW;
END
$fn$;
CREATE TRIGGER produce_task_posts_task BEFORE INSERT ON produce_task_posts FOR EACH ROW EXECUTE FUNCTION produce_task_posts_task_fn();
CREATE TRIGGER produce_task_posts_no_update BEFORE UPDATE ON produce_task_posts FOR EACH ROW EXECUTE FUNCTION lite_reject_change('produce record immutable');
CREATE TRIGGER produce_task_posts_no_delete BEFORE DELETE ON produce_task_posts FOR EACH ROW EXECUTE FUNCTION lite_reject_change('produce record immutable');
CREATE INDEX produce_task_posts_task_idx ON produce_task_posts (org_id, project_id, task_uid);
CREATE INDEX produce_task_posts_author_idx ON produce_task_posts (org_id, created_by);
CREATE TABLE produce_task_links (
  id bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  org_id bigint NOT NULL,
  project_id bigint NOT NULL,
  task_uid bigint NOT NULL CHECK (lite_typeof(task_uid) = 'integer' AND task_uid > 0),
  link_uid bigint NOT NULL CHECK (lite_typeof(link_uid) = 'integer' AND link_uid > 0),
  label text COLLATE "C" NOT NULL CHECK (length(trim(label)) BETWEEN 1 AND 120),
  target text COLLATE "C" NOT NULL CHECK (length(trim(target)) BETWEEN 1 AND 500),
  is_fallback bigint NOT NULL DEFAULT 0 CHECK (is_fallback IN (0, 1)),
  removed bigint NOT NULL DEFAULT 0 CHECK (removed IN (0, 1)),
  created_by bigint NOT NULL,
  created_at text COLLATE "C" NOT NULL DEFAULT to_char(statement_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS'),
  UNIQUE (org_id, id)
);
CREATE FUNCTION produce_task_links_task_fn() RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  IF (NOT EXISTS (SELECT 1 FROM produce_tasks t WHERE t.org_id = NEW.org_id AND t.project_id = NEW.project_id AND t.task_uid = NEW.task_uid)) IS NOT TRUE THEN RETURN NEW; END IF;
  RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'produce task not found';
  RETURN NEW;
END
$fn$;
CREATE TRIGGER produce_task_links_task BEFORE INSERT ON produce_task_links FOR EACH ROW EXECUTE FUNCTION produce_task_links_task_fn();
CREATE TRIGGER produce_task_links_no_update BEFORE UPDATE ON produce_task_links FOR EACH ROW EXECUTE FUNCTION lite_reject_change('produce record immutable');
CREATE TRIGGER produce_task_links_no_delete BEFORE DELETE ON produce_task_links FOR EACH ROW EXECUTE FUNCTION lite_reject_change('produce record immutable');
CREATE INDEX produce_task_links_task_idx ON produce_task_links (org_id, project_id, task_uid, link_uid);
CREATE INDEX produce_task_links_author_idx ON produce_task_links (org_id, created_by);
CREATE TABLE produce_task_templates (
  id bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  org_id bigint NOT NULL,
  template_uid bigint NOT NULL CHECK (lite_typeof(template_uid) = 'integer' AND template_uid > 0),
  version_no bigint NOT NULL CHECK (lite_typeof(version_no) = 'integer' AND version_no > 0),
  name text COLLATE "C" NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 120),
  anchor_kind text COLLATE "C" NOT NULL CHECK (anchor_kind IN ('crank_in', 'project_start')),
  retired bigint NOT NULL DEFAULT 0 CHECK (retired IN (0, 1)),
  reason text COLLATE "C" CHECK (reason IS NULL OR length(trim(reason)) BETWEEN 1 AND 500),
  created_by bigint NOT NULL,
  created_at text COLLATE "C" NOT NULL DEFAULT to_char(statement_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS'),
  UNIQUE (org_id, id),
  UNIQUE (org_id, template_uid, version_no),
  CHECK (version_no = 1 OR reason IS NOT NULL)
);
CREATE FUNCTION produce_task_templates_sequence_fn() RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  IF (NEW.version_no <> (SELECT COALESCE(max(t.version_no), 0) + 1 FROM produce_task_templates t WHERE t.org_id = NEW.org_id AND t.template_uid = NEW.template_uid)) IS NOT TRUE THEN RETURN NEW; END IF;
  RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'stale produce template';
  RETURN NEW;
END
$fn$;
CREATE TRIGGER produce_task_templates_sequence BEFORE INSERT ON produce_task_templates FOR EACH ROW EXECUTE FUNCTION produce_task_templates_sequence_fn();
CREATE TRIGGER produce_task_templates_no_update BEFORE UPDATE ON produce_task_templates FOR EACH ROW EXECUTE FUNCTION lite_reject_change('produce record immutable');
CREATE TRIGGER produce_task_templates_no_delete BEFORE DELETE ON produce_task_templates FOR EACH ROW EXECUTE FUNCTION lite_reject_change('produce record immutable');
CREATE INDEX produce_task_templates_author_idx ON produce_task_templates (org_id, created_by);
CREATE TABLE produce_task_template_items (
  id bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  org_id bigint NOT NULL,
  template_id bigint NOT NULL,
  sort_no bigint NOT NULL CHECK (lite_typeof(sort_no) = 'integer' AND sort_no BETWEEN 1 AND 500),
  kind text COLLATE "C" NOT NULL CHECK (kind IN ('work', 'check', 'milestone')),
  phase text COLLATE "C" NOT NULL CHECK (phase IN ('script', 'prep', 'shoot', 'post', 'delivery', 'finance')),
  title text COLLATE "C" NOT NULL CHECK (length(trim(title)) BETWEEN 1 AND 120),
  role text COLLATE "C" NOT NULL CHECK (role IN ('producer', 'line_producer')),
  checkers text COLLATE "C" CHECK (checkers IS NULL OR length(trim(checkers)) BETWEEN 1 AND 200),
  start_offset_days bigint NOT NULL CHECK (lite_typeof(start_offset_days) = 'integer' AND start_offset_days BETWEEN - 3650 AND 3650),
  end_offset_days bigint NOT NULL CHECK (lite_typeof(end_offset_days) = 'integer' AND end_offset_days BETWEEN - 3650 AND 3650),
  milestone_code text COLLATE "C" CHECK (milestone_code IS NULL OR milestone_code IN ('kikaku_go', 'crank_in', 'crank_up', 'edit_lock', 'sound_mix', 'first_print', 'final_screening', 'release', 'delivery')),
  links_json text COLLATE "C" NOT NULL DEFAULT '[]' CHECK (lite_json_valid(links_json) AND lite_json_type(links_json) = 'array' AND length(links_json) <= 4000),
  UNIQUE (org_id, id),
  UNIQUE (org_id, template_id, sort_no),
  CHECK (end_offset_days >= start_offset_days),
  CHECK (kind <> 'milestone' OR end_offset_days = start_offset_days)
);
CREATE TRIGGER produce_task_template_items_no_update BEFORE UPDATE ON produce_task_template_items FOR EACH ROW EXECUTE FUNCTION lite_reject_change('produce record immutable');
CREATE TRIGGER produce_task_template_items_no_delete BEFORE DELETE ON produce_task_template_items FOR EACH ROW EXECUTE FUNCTION lite_reject_change('produce record immutable');
CREATE INDEX produce_task_template_items_template_idx ON produce_task_template_items (org_id, template_id);

-- ===== 0048_post_production.sql =====
CREATE TABLE post_cuts (
  id bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  org_id bigint NOT NULL,
  project_id bigint NOT NULL,
  work_id bigint NOT NULL,
  episode_no bigint CHECK (episode_no IS NULL OR (lite_typeof(episode_no) = 'integer' AND episode_no BETWEEN 1 AND 999)),
  variant text COLLATE "C" CHECK (variant IS NULL OR length(trim(variant)) BETWEEN 1 AND 60),
  label text COLLATE "C" NOT NULL CHECK (length(trim(label)) BETWEEN 1 AND 40),
  kind text COLLATE "C" NOT NULL CHECK (kind IN ('work', 'locked', 'final')),
  delivered_on text COLLATE "C" CHECK (delivered_on IS NULL OR (length(delivered_on) = 10 AND substr(delivered_on, 5, 1) = '-' AND substr(delivered_on, 8, 1) = '-' AND ltrim(substr(delivered_on, 1, 4) || substr(delivered_on, 6, 2) || substr(delivered_on, 9, 2), '0123456789') = '')),
  runtime_seconds bigint CHECK (runtime_seconds IS NULL OR (lite_typeof(runtime_seconds) = 'integer' AND runtime_seconds BETWEEN 1 AND 86400)),
  review_url text COLLATE "C" CHECK (review_url IS NULL OR (length(review_url) BETWEEN 12 AND 500 AND substr(review_url, 1, 8) = 'https://')),
  created_by bigint NOT NULL,
  created_at text COLLATE "C" NOT NULL DEFAULT to_char(statement_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS'),
  UNIQUE (org_id, id),
  UNIQUE (org_id, work_id, id)
);
CREATE TRIGGER post_cuts_no_update BEFORE UPDATE ON post_cuts FOR EACH ROW EXECUTE FUNCTION lite_reject_change('post record immutable');
CREATE TRIGGER post_cuts_no_delete BEFORE DELETE ON post_cuts FOR EACH ROW EXECUTE FUNCTION lite_reject_change('post record immutable');
CREATE INDEX post_cuts_work_idx ON post_cuts (org_id, project_id, work_id);
CREATE INDEX post_cuts_author_idx ON post_cuts (org_id, created_by);
CREATE TABLE post_notes (
  id bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  org_id bigint NOT NULL,
  work_id bigint NOT NULL,
  cut_id bigint NOT NULL,
  tc_in_seconds bigint NOT NULL CHECK (lite_typeof(tc_in_seconds) = 'integer' AND tc_in_seconds BETWEEN 0 AND 86400),
  tc_out_seconds bigint CHECK (tc_out_seconds IS NULL OR (lite_typeof(tc_out_seconds) = 'integer' AND tc_out_seconds BETWEEN 0 AND 86400)),
  viewpoint text COLLATE "C" NOT NULL CHECK (length(trim(viewpoint)) BETWEEN 1 AND 40),
  from_role text COLLATE "C" NOT NULL CHECK (length(trim(from_role)) BETWEEN 1 AND 40),
  assignee text COLLATE "C" NOT NULL CHECK (length(trim(assignee)) BETWEEN 1 AND 40),
  body text COLLATE "C" NOT NULL CHECK (length(trim(body)) BETWEEN 1 AND 2000),
  created_by bigint NOT NULL,
  created_at text COLLATE "C" NOT NULL DEFAULT to_char(statement_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS'),
  UNIQUE (org_id, id),
  UNIQUE (org_id, work_id, id),
  CHECK (tc_out_seconds IS NULL OR tc_out_seconds >= tc_in_seconds)
);
CREATE TRIGGER post_notes_no_update BEFORE UPDATE ON post_notes FOR EACH ROW EXECUTE FUNCTION lite_reject_change('post record immutable');
CREATE TRIGGER post_notes_no_delete BEFORE DELETE ON post_notes FOR EACH ROW EXECUTE FUNCTION lite_reject_change('post record immutable');
CREATE INDEX post_notes_cut_idx ON post_notes (org_id, work_id, cut_id);
CREATE INDEX post_notes_author_idx ON post_notes (org_id, created_by);
CREATE TABLE post_note_actions (
  id bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  org_id bigint NOT NULL,
  work_id bigint NOT NULL,
  note_id bigint NOT NULL,
  result text COLLATE "C" NOT NULL CHECK (result IN ('fixed', 'skipped', 'hold', 'reopen')),
  fixed_cut_id bigint,
  reason text COLLATE "C" CHECK (reason IS NULL OR length(trim(reason)) BETWEEN 1 AND 1000),
  created_by bigint NOT NULL,
  created_at text COLLATE "C" NOT NULL DEFAULT to_char(statement_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS'),
  UNIQUE (org_id, id),
  CHECK (result <> 'skipped' OR reason IS NOT NULL)
);
CREATE TRIGGER post_note_actions_no_update BEFORE UPDATE ON post_note_actions FOR EACH ROW EXECUTE FUNCTION lite_reject_change('post record immutable');
CREATE TRIGGER post_note_actions_no_delete BEFORE DELETE ON post_note_actions FOR EACH ROW EXECUTE FUNCTION lite_reject_change('post record immutable');
CREATE INDEX post_note_actions_note_idx ON post_note_actions (org_id, work_id, note_id);
CREATE INDEX post_note_actions_cut_idx ON post_note_actions (org_id, work_id, fixed_cut_id);
CREATE INDEX post_note_actions_author_idx ON post_note_actions (org_id, created_by);
CREATE TABLE post_tasks (
  id bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  org_id bigint NOT NULL,
  project_id bigint NOT NULL,
  work_id bigint NOT NULL,
  phase text COLLATE "C" NOT NULL CHECK (phase IN ('edit', 'sound', 'color', 'screening', 'final_screening', 'delivery', 'other')),
  episode_no bigint CHECK (episode_no IS NULL OR (lite_typeof(episode_no) = 'integer' AND episode_no BETWEEN 1 AND 999)),
  name text COLLATE "C" NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 200),
  due_on text COLLATE "C" CHECK (due_on IS NULL OR (length(due_on) = 10 AND substr(due_on, 5, 1) = '-' AND substr(due_on, 8, 1) = '-' AND ltrim(substr(due_on, 1, 4) || substr(due_on, 6, 2) || substr(due_on, 9, 2), '0123456789') = '')),
  assignee text COLLATE "C" CHECK (assignee IS NULL OR length(trim(assignee)) BETWEEN 1 AND 60),
  created_by bigint NOT NULL,
  created_at text COLLATE "C" NOT NULL DEFAULT to_char(statement_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS'),
  UNIQUE (org_id, id),
  UNIQUE (org_id, work_id, id)
);
CREATE TRIGGER post_tasks_no_update BEFORE UPDATE ON post_tasks FOR EACH ROW EXECUTE FUNCTION lite_reject_change('post record immutable');
CREATE TRIGGER post_tasks_no_delete BEFORE DELETE ON post_tasks FOR EACH ROW EXECUTE FUNCTION lite_reject_change('post record immutable');
CREATE INDEX post_tasks_work_idx ON post_tasks (org_id, project_id, work_id);
CREATE INDEX post_tasks_author_idx ON post_tasks (org_id, created_by);
CREATE TABLE post_task_events (
  id bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  org_id bigint NOT NULL,
  work_id bigint NOT NULL,
  task_id bigint NOT NULL,
  kind text COLLATE "C" NOT NULL CHECK (kind IN ('done', 'undone', 'due')),
  due_on text COLLATE "C" CHECK (due_on IS NULL OR (length(due_on) = 10 AND substr(due_on, 5, 1) = '-' AND substr(due_on, 8, 1) = '-' AND ltrim(substr(due_on, 1, 4) || substr(due_on, 6, 2) || substr(due_on, 9, 2), '0123456789') = '')),
  on_date text COLLATE "C" NOT NULL CHECK (length(on_date) = 10 AND substr(on_date, 5, 1) = '-' AND substr(on_date, 8, 1) = '-' AND ltrim(substr(on_date, 1, 4) || substr(on_date, 6, 2) || substr(on_date, 9, 2), '0123456789') = ''),
  created_by bigint NOT NULL,
  created_at text COLLATE "C" NOT NULL DEFAULT to_char(statement_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS'),
  UNIQUE (org_id, id),
  CHECK ((kind = 'due' AND due_on IS NOT NULL) OR (kind <> 'due' AND due_on IS NULL))
);
CREATE TRIGGER post_task_events_no_update BEFORE UPDATE ON post_task_events FOR EACH ROW EXECUTE FUNCTION lite_reject_change('post record immutable');
CREATE TRIGGER post_task_events_no_delete BEFORE DELETE ON post_task_events FOR EACH ROW EXECUTE FUNCTION lite_reject_change('post record immutable');
CREATE INDEX post_task_events_task_idx ON post_task_events (org_id, work_id, task_id);
CREATE INDEX post_task_events_author_idx ON post_task_events (org_id, created_by);
CREATE TABLE post_deliverable_items (
  id bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  org_id bigint NOT NULL,
  project_id bigint NOT NULL,
  work_id bigint NOT NULL,
  source_kind text COLLATE "C" NOT NULL CHECK (source_kind IN ('contract', 'guide', 'manual')),
  committee_contract_id bigint,
  committee_term_version_id bigint,
  sales_deliverable_id bigint,
  section text COLLATE "C" CHECK (section IS NULL OR length(trim(section)) BETWEEN 1 AND 40),
  name text COLLATE "C" NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 200),
  episode_no bigint CHECK (episode_no IS NULL OR (lite_typeof(episode_no) = 'integer' AND episode_no BETWEEN 1 AND 999)),
  spec text COLLATE "C" CHECK (spec IS NULL OR length(trim(spec)) BETWEEN 1 AND 1000),
  owner text COLLATE "C" CHECK (owner IS NULL OR length(trim(owner)) BETWEEN 1 AND 40),
  created_by bigint NOT NULL,
  created_at text COLLATE "C" NOT NULL DEFAULT to_char(statement_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS'),
  UNIQUE (org_id, id),
  UNIQUE (org_id, work_id, id),
  CHECK (committee_term_version_id IS NULL OR committee_contract_id IS NOT NULL)
);
CREATE TRIGGER post_deliverable_items_no_update BEFORE UPDATE ON post_deliverable_items FOR EACH ROW EXECUTE FUNCTION lite_reject_change('post record immutable');
CREATE TRIGGER post_deliverable_items_no_delete BEFORE DELETE ON post_deliverable_items FOR EACH ROW EXECUTE FUNCTION lite_reject_change('post record immutable');
CREATE INDEX post_deliverable_items_work_idx ON post_deliverable_items (org_id, project_id, work_id);
CREATE INDEX post_deliverable_items_term_idx ON post_deliverable_items (org_id, committee_contract_id, committee_term_version_id);
CREATE INDEX post_deliverable_items_sales_idx ON post_deliverable_items (org_id, sales_deliverable_id);
CREATE INDEX post_deliverable_items_author_idx ON post_deliverable_items (org_id, created_by);
CREATE TABLE post_deliverable_events (
  id bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  org_id bigint NOT NULL,
  work_id bigint NOT NULL,
  item_id bigint NOT NULL,
  status text COLLATE "C" NOT NULL CHECK (status IN ('pending', 'making', 'in_review', 'redo', 'delivered')),
  on_date text COLLATE "C" NOT NULL CHECK (length(on_date) = 10 AND substr(on_date, 5, 1) = '-' AND substr(on_date, 8, 1) = '-' AND ltrim(substr(on_date, 1, 4) || substr(on_date, 6, 2) || substr(on_date, 9, 2), '0123456789') = ''),
  note text COLLATE "C" CHECK (note IS NULL OR length(trim(note)) BETWEEN 1 AND 500),
  created_by bigint NOT NULL,
  created_at text COLLATE "C" NOT NULL DEFAULT to_char(statement_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS'),
  UNIQUE (org_id, id)
);
CREATE TRIGGER post_deliverable_events_no_update BEFORE UPDATE ON post_deliverable_events FOR EACH ROW EXECUTE FUNCTION lite_reject_change('post record immutable');
CREATE TRIGGER post_deliverable_events_no_delete BEFORE DELETE ON post_deliverable_events FOR EACH ROW EXECUTE FUNCTION lite_reject_change('post record immutable');
CREATE INDEX post_deliverable_events_item_idx ON post_deliverable_events (org_id, work_id, item_id);
CREATE INDEX post_deliverable_events_author_idx ON post_deliverable_events (org_id, created_by);

-- ===== 0049_sales_proposals_reviews_notes.sql =====
CREATE TABLE sales_proposals (
  id bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  org_id bigint NOT NULL,
  opportunity_id bigint NOT NULL,
  proposed_on text COLLATE "C" NOT NULL CHECK (length(proposed_on) = 10 AND substr(proposed_on, 5, 1) = '-' AND substr(proposed_on, 8, 1) = '-' AND ltrim(substr(proposed_on, 1, 4) || substr(proposed_on, 6, 2) || substr(proposed_on, 9, 2), '0123456789') = ''),
  settlement_method text COLLATE "C" NOT NULL CHECK (settlement_method IN ('unverified', 'FLAT', 'MG', 'RS', 'other')),
  amount_ex_tax bigint CHECK (amount_ex_tax IS NULL OR (lite_typeof(amount_ex_tax) = 'integer' AND amount_ex_tax BETWEEN 0 AND 1000000000000)),
  rate_bps bigint CHECK (rate_bps IS NULL OR (lite_typeof(rate_bps) = 'integer' AND rate_bps BETWEEN 0 AND 10000)),
  term_start text COLLATE "C" CHECK (term_start IS NULL OR (length(term_start) = 10 AND substr(term_start, 5, 1) = '-' AND substr(term_start, 8, 1) = '-' AND ltrim(substr(term_start, 1, 4) || substr(term_start, 6, 2) || substr(term_start, 9, 2), '0123456789') = '')),
  term_end text COLLATE "C" CHECK (term_end IS NULL OR (length(term_end) = 10 AND substr(term_end, 5, 1) = '-' AND substr(term_end, 8, 1) = '-' AND ltrim(substr(term_end, 1, 4) || substr(term_end, 6, 2) || substr(term_end, 9, 2), '0123456789') = '')),
  exclusivity text COLLATE "C" NOT NULL CHECK (exclusivity IN ('unknown', 'exclusive', 'nonexclusive')),
  material_snapshot_id bigint,
  pitch_note text COLLATE "C" CHECK (pitch_note IS NULL OR length(trim(pitch_note)) BETWEEN 1 AND 2000),
  created_by bigint NOT NULL,
  created_at text COLLATE "C" NOT NULL DEFAULT to_char(statement_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS'),
  UNIQUE (org_id, id),
  CHECK (term_end IS NULL OR term_start IS NULL OR term_end >= term_start),
  CHECK (settlement_method <> 'RS' OR amount_ex_tax IS NULL),
  CHECK (settlement_method <> 'FLAT' OR rate_bps IS NULL)
);
CREATE INDEX sales_proposals_opportunity ON sales_proposals (org_id, opportunity_id, proposed_on);
CREATE TRIGGER sales_proposals_no_update BEFORE UPDATE ON sales_proposals FOR EACH ROW EXECUTE FUNCTION lite_reject_change('sales proposal record immutable');
CREATE TRIGGER sales_proposals_no_delete BEFORE DELETE ON sales_proposals FOR EACH ROW EXECUTE FUNCTION lite_reject_change('sales proposal record immutable');
CREATE TABLE sales_proposal_windows (
  org_id bigint NOT NULL,
  proposal_id bigint NOT NULL,
  window_id bigint NOT NULL,
  created_at text COLLATE "C" NOT NULL DEFAULT to_char(statement_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS'),
  PRIMARY KEY (org_id, proposal_id, window_id)
);
CREATE TRIGGER sales_proposal_windows_no_update BEFORE UPDATE ON sales_proposal_windows FOR EACH ROW EXECUTE FUNCTION lite_reject_change('sales proposal record immutable');
CREATE TRIGGER sales_proposal_windows_no_delete BEFORE DELETE ON sales_proposal_windows FOR EACH ROW EXECUTE FUNCTION lite_reject_change('sales proposal record immutable');
CREATE TABLE sales_proposal_reviews (
  id bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  org_id bigint NOT NULL,
  proposal_id bigint NOT NULL,
  reviewed_on text COLLATE "C" NOT NULL CHECK (length(reviewed_on) = 10 AND substr(reviewed_on, 5, 1) = '-' AND substr(reviewed_on, 8, 1) = '-' AND ltrim(substr(reviewed_on, 1, 4) || substr(reviewed_on, 6, 2) || substr(reviewed_on, 9, 2), '0123456789') = ''),
  outcome text COLLATE "C" NOT NULL CHECK (outcome IN ('adopted', 'adopted_changed', 'rejected', 'no_answer', 'withdrawn')),
  score bigint NOT NULL CHECK (lite_typeof(score) = 'integer' AND score BETWEEN 1 AND 5),
  worked text COLLATE "C" CHECK (worked IS NULL OR length(trim(worked)) BETWEEN 1 AND 2000),
  missed text COLLATE "C" CHECK (missed IS NULL OR length(trim(missed)) BETWEEN 1 AND 2000),
  agreement_id bigint,
  created_by bigint NOT NULL,
  created_at text COLLATE "C" NOT NULL DEFAULT to_char(statement_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS'),
  UNIQUE (org_id, id),
  CHECK (agreement_id IS NULL OR outcome IN ('adopted', 'adopted_changed'))
);
CREATE INDEX sales_proposal_reviews_proposal ON sales_proposal_reviews (org_id, proposal_id, id);
CREATE TRIGGER sales_proposal_reviews_no_update BEFORE UPDATE ON sales_proposal_reviews FOR EACH ROW EXECUTE FUNCTION lite_reject_change('sales proposal record immutable');
CREATE TRIGGER sales_proposal_reviews_no_delete BEFORE DELETE ON sales_proposal_reviews FOR EACH ROW EXECUTE FUNCTION lite_reject_change('sales proposal record immutable');
CREATE TABLE sales_proposal_review_factors (
  org_id bigint NOT NULL,
  review_id bigint NOT NULL,
  factor text COLLATE "C" NOT NULL CHECK (factor IN ('material', 'price', 'term', 'timing', 'exclusivity', 'relationship', 'title_strength', 'competition', 'other')),
  effect text COLLATE "C" NOT NULL CHECK (effect IN ('plus', 'minus')),
  PRIMARY KEY (org_id, review_id, factor)
);
CREATE TRIGGER sales_proposal_review_factors_no_update BEFORE UPDATE ON sales_proposal_review_factors FOR EACH ROW EXECUTE FUNCTION lite_reject_change('sales proposal record immutable');
CREATE TRIGGER sales_proposal_review_factors_no_delete BEFORE DELETE ON sales_proposal_review_factors FOR EACH ROW EXECUTE FUNCTION lite_reject_change('sales proposal record immutable');
CREATE TABLE sales_activity_notes (
  id bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  org_id bigint NOT NULL,
  activity_id bigint NOT NULL,
  note_kind text COLLATE "C" NOT NULL CHECK (note_kind IN ('fact', 'their_words', 'my_read')),
  body text COLLATE "C" NOT NULL CHECK (length(trim(body)) BETWEEN 1 AND 2000),
  tone bigint CHECK (tone IS NULL OR (lite_typeof(tone) = 'integer' AND tone BETWEEN - 2 AND 2)),
  created_by bigint NOT NULL,
  created_at text COLLATE "C" NOT NULL DEFAULT to_char(statement_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS'),
  UNIQUE (org_id, id)
);
CREATE INDEX sales_activity_notes_activity ON sales_activity_notes (org_id, activity_id, id);
CREATE TRIGGER sales_activity_notes_no_update BEFORE UPDATE ON sales_activity_notes FOR EACH ROW EXECUTE FUNCTION lite_reject_change('sales activity note immutable');
CREATE TRIGGER sales_activity_notes_no_delete BEFORE DELETE ON sales_activity_notes FOR EACH ROW EXECUTE FUNCTION lite_reject_change('sales activity note immutable');

-- ===== 0050_kikaku.sql =====
CREATE TABLE planning_documents (
  id bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  org_id bigint NOT NULL,
  project_id bigint NOT NULL,
  document_id bigint NOT NULL,
  kind text COLLATE "C" NOT NULL CHECK (kind IN ('deck', 'trial', 'material')),
  role text COLLATE "C" CHECK (role IS NULL OR role IN ('draft', 'submitted')),
  submitted_to text COLLATE "C" CHECK (submitted_to IS NULL OR length(trim(submitted_to)) BETWEEN 1 AND 200),
  submitted_on text COLLATE "C" CHECK (submitted_on IS NULL OR (length(submitted_on) = 10 AND substr(submitted_on, 5, 1) = '-' AND substr(submitted_on, 8, 1) = '-' AND ltrim(substr(submitted_on, 1, 4) || substr(submitted_on, 6, 2) || substr(submitted_on, 9, 2), '0123456789') = '')),
  note text COLLATE "C" CHECK (note IS NULL OR length(note) BETWEEN 1 AND 1000),
  created_by bigint NOT NULL,
  created_at text COLLATE "C" NOT NULL DEFAULT to_char(statement_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS'),
  UNIQUE (org_id, id),
  CHECK (kind = 'deck' OR role IS NULL),
  CHECK (role = 'submitted' OR (submitted_to IS NULL AND submitted_on IS NULL)),
  CHECK (role IS NULL OR role <> 'submitted' OR submitted_on IS NOT NULL)
);
CREATE TRIGGER planning_documents_no_update BEFORE UPDATE ON planning_documents FOR EACH ROW EXECUTE FUNCTION lite_reject_change('planning record immutable');
CREATE TRIGGER planning_documents_no_delete BEFORE DELETE ON planning_documents FOR EACH ROW EXECUTE FUNCTION lite_reject_change('planning record immutable');
CREATE INDEX planning_documents_project_idx ON planning_documents (org_id, project_id);
CREATE INDEX planning_documents_document_idx ON planning_documents (org_id, document_id);
CREATE INDEX planning_documents_author_idx ON planning_documents (org_id, created_by);
CREATE TABLE planning_profile_versions (
  id bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  org_id bigint NOT NULL,
  project_id bigint NOT NULL,
  revision bigint NOT NULL CHECK (lite_typeof(revision) = 'integer' AND revision > 0),
  working_title text COLLATE "C" NOT NULL CHECK (length(trim(working_title)) BETWEEN 1 AND 200),
  origin text COLLATE "C" NOT NULL CHECK (origin IN ('source', 'cast', 'concept', 'sequel', 'other')),
  logline text COLLATE "C" CHECK (logline IS NULL OR length(logline) BETWEEN 1 AND 1000),
  synopsis_short text COLLATE "C" CHECK (synopsis_short IS NULL OR length(synopsis_short) BETWEEN 1 AND 1000),
  synopsis_long text COLLATE "C" CHECK (synopsis_long IS NULL OR length(synopsis_long) BETWEEN 1 AND 5000),
  format text COLLATE "C" CHECK (format IS NULL OR length(trim(format)) BETWEEN 1 AND 100),
  episode_count bigint CHECK (episode_count IS NULL OR (lite_typeof(episode_count) = 'integer' AND episode_count BETWEEN 1 AND 1000)),
  planned_release_year bigint CHECK (planned_release_year IS NULL OR (lite_typeof(planned_release_year) = 'integer' AND planned_release_year BETWEEN 1900 AND 2200)),
  submit_to text COLLATE "C" CHECK (submit_to IS NULL OR length(trim(submit_to)) BETWEEN 1 AND 200),
  reason text COLLATE "C" NOT NULL CHECK (length(trim(reason)) BETWEEN 1 AND 1000),
  created_by bigint NOT NULL,
  created_at text COLLATE "C" NOT NULL DEFAULT to_char(statement_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS'),
  UNIQUE (org_id, id),
  UNIQUE (org_id, project_id, revision)
);
CREATE FUNCTION planning_profile_versions_sequence_fn() RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  IF (NEW.revision <> (SELECT COALESCE(max(v.revision), 0) + 1 FROM planning_profile_versions v WHERE v.org_id = NEW.org_id AND v.project_id = NEW.project_id)) IS NOT TRUE THEN RETURN NEW; END IF;
  RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'stale planning profile';
  RETURN NEW;
END
$fn$;
CREATE TRIGGER planning_profile_versions_sequence BEFORE INSERT ON planning_profile_versions FOR EACH ROW EXECUTE FUNCTION planning_profile_versions_sequence_fn();
CREATE TRIGGER planning_profile_versions_no_update BEFORE UPDATE ON planning_profile_versions FOR EACH ROW EXECUTE FUNCTION lite_reject_change('planning record immutable');
CREATE TRIGGER planning_profile_versions_no_delete BEFORE DELETE ON planning_profile_versions FOR EACH ROW EXECUTE FUNCTION lite_reject_change('planning record immutable');
CREATE INDEX planning_profile_versions_author_idx ON planning_profile_versions (org_id, created_by);
CREATE TABLE planning_profile_people (
  id bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  org_id bigint NOT NULL,
  version_id bigint NOT NULL,
  position bigint NOT NULL CHECK (lite_typeof(position) = 'integer' AND position BETWEEN 1 AND 100),
  role text COLLATE "C" NOT NULL CHECK (role IN ('director', 'writer', 'lead', 'support', 'producer', 'studio', 'other')),
  name text COLLATE "C" NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 200),
  status text COLLATE "C" NOT NULL CHECK (status IN ('candidate', 'negotiating', 'confirmed')),
  UNIQUE (org_id, version_id, position)
);
CREATE TRIGGER planning_profile_people_no_update BEFORE UPDATE ON planning_profile_people FOR EACH ROW EXECUTE FUNCTION lite_reject_change('planning record immutable');
CREATE TRIGGER planning_profile_people_no_delete BEFORE DELETE ON planning_profile_people FOR EACH ROW EXECUTE FUNCTION lite_reject_change('planning record immutable');
CREATE TABLE planning_trial_versions (
  id bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  org_id bigint NOT NULL,
  project_id bigint NOT NULL,
  revision bigint NOT NULL CHECK (lite_typeof(revision) = 'integer' AND revision > 0),
  cost_total_yen bigint NOT NULL CHECK (lite_typeof(cost_total_yen) = 'integer' AND cost_total_yen BETWEEN 0 AND 1000000000000),
  first_month text COLLATE "C" NOT NULL CHECK (length(first_month) = 7 AND substr(first_month, 5, 1) = '-' AND ltrim(substr(first_month, 1, 4) || substr(first_month, 6, 2), '0123456789') = '' AND substr(first_month, 6, 2) BETWEEN '01' AND '12'),
  source_kind text COLLATE "C" NOT NULL CHECK (source_kind IN ('screen', 'template', 'copy', 'file')),
  document_id bigint,
  reason text COLLATE "C" NOT NULL CHECK (length(trim(reason)) BETWEEN 1 AND 1000),
  created_by bigint NOT NULL,
  created_at text COLLATE "C" NOT NULL DEFAULT to_char(statement_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS'),
  UNIQUE (org_id, id),
  UNIQUE (org_id, project_id, revision),
  CHECK ((source_kind = 'file' AND document_id IS NOT NULL) OR source_kind <> 'file')
);
CREATE FUNCTION planning_trial_versions_sequence_fn() RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  IF (NEW.revision <> (SELECT COALESCE(max(v.revision), 0) + 1 FROM planning_trial_versions v WHERE v.org_id = NEW.org_id AND v.project_id = NEW.project_id)) IS NOT TRUE THEN RETURN NEW; END IF;
  RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'stale planning trial';
  RETURN NEW;
END
$fn$;
CREATE TRIGGER planning_trial_versions_sequence BEFORE INSERT ON planning_trial_versions FOR EACH ROW EXECUTE FUNCTION planning_trial_versions_sequence_fn();
CREATE TRIGGER planning_trial_versions_no_update BEFORE UPDATE ON planning_trial_versions FOR EACH ROW EXECUTE FUNCTION lite_reject_change('planning record immutable');
CREATE TRIGGER planning_trial_versions_no_delete BEFORE DELETE ON planning_trial_versions FOR EACH ROW EXECUTE FUNCTION lite_reject_change('planning record immutable');
CREATE INDEX planning_trial_versions_document_idx ON planning_trial_versions (org_id, document_id);
CREATE INDEX planning_trial_versions_author_idx ON planning_trial_versions (org_id, created_by);
CREATE TABLE planning_trial_rates (
  id bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  org_id bigint NOT NULL,
  version_id bigint NOT NULL,
  type_code text COLLATE "C" NOT NULL CHECK (type_code IN ('THEA', 'EVNT', 'PVOD', 'EST', 'TVOD', 'SVOD', 'AVOD', 'BIZ', 'BCST', 'SELL', 'RENT', 'OVS', 'GOOD')),
  share_bps bigint NOT NULL CHECK (lite_typeof(share_bps) = 'integer' AND share_bps BETWEEN 0 AND 10000),
  fee_bps bigint NOT NULL CHECK (lite_typeof(fee_bps) = 'integer' AND fee_bps BETWEEN 0 AND 10000),
  original_royalty_bps bigint NOT NULL CHECK (lite_typeof(original_royalty_bps) = 'integer' AND original_royalty_bps BETWEEN 0 AND 10000),
  creator_royalty_bps bigint NOT NULL CHECK (lite_typeof(creator_royalty_bps) = 'integer' AND creator_royalty_bps BETWEEN 0 AND 10000),
  unit_cost_yen bigint NOT NULL CHECK (lite_typeof(unit_cost_yen) = 'integer' AND unit_cost_yen BETWEEN 0 AND 100000000),
  source text COLLATE "C" CHECK (source IS NULL OR length(trim(source)) BETWEEN 1 AND 200),
  UNIQUE (org_id, version_id, type_code),
  CHECK (fee_bps + original_royalty_bps + creator_royalty_bps <= 10000)
);
CREATE TRIGGER planning_trial_rates_no_update BEFORE UPDATE ON planning_trial_rates FOR EACH ROW EXECUTE FUNCTION lite_reject_change('planning record immutable');
CREATE TRIGGER planning_trial_rates_no_delete BEFORE DELETE ON planning_trial_rates FOR EACH ROW EXECUTE FUNCTION lite_reject_change('planning record immutable');
CREATE TABLE planning_trial_lines (
  id bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  org_id bigint NOT NULL,
  version_id bigint NOT NULL,
  line_no bigint NOT NULL CHECK (lite_typeof(line_no) = 'integer' AND line_no BETWEEN 1 AND 500),
  type_code text COLLATE "C" NOT NULL CHECK (type_code IN ('THEA', 'EVNT', 'PVOD', 'EST', 'TVOD', 'SVOD', 'AVOD', 'BIZ', 'BCST', 'SELL', 'RENT', 'OVS', 'GOOD')),
  partner_name text COLLATE "C" NOT NULL CHECK (length(trim(partner_name)) BETWEEN 1 AND 200),
  window_label text COLLATE "C" CHECK (window_label IS NULL OR length(trim(window_label)) BETWEEN 1 AND 100),
  start_month text COLLATE "C" NOT NULL CHECK (length(start_month) = 7 AND substr(start_month, 5, 1) = '-' AND ltrim(substr(start_month, 1, 4) || substr(start_month, 6, 2), '0123456789') = '' AND substr(start_month, 6, 2) BETWEEN '01' AND '12'),
  months bigint NOT NULL CHECK (lite_typeof(months) = 'integer' AND months BETWEEN 1 AND 120),
  calc text COLLATE "C" NOT NULL CHECK (calc IN ('unit', 'fixed')),
  unit_price_yen bigint NOT NULL CHECK (lite_typeof(unit_price_yen) = 'integer' AND unit_price_yen BETWEEN 0 AND 100000000),
  even_value bigint NOT NULL CHECK (lite_typeof(even_value) = 'integer' AND even_value BETWEEN 0 AND 1000000000000),
  good_value bigint NOT NULL CHECK (lite_typeof(good_value) = 'integer' AND good_value BETWEEN 0 AND 1000000000000),
  max_value bigint NOT NULL CHECK (lite_typeof(max_value) = 'integer' AND max_value BETWEEN 0 AND 1000000000000),
  source text COLLATE "C" CHECK (source IS NULL OR length(trim(source)) BETWEEN 1 AND 200),
  previous_sales_yen bigint CHECK (previous_sales_yen IS NULL OR (lite_typeof(previous_sales_yen) = 'integer' AND previous_sales_yen BETWEEN 0 AND 1000000000000)),
  UNIQUE (org_id, version_id, line_no),
  CHECK (calc = 'fixed' OR unit_price_yen > 0)
);
CREATE TRIGGER planning_trial_lines_no_update BEFORE UPDATE ON planning_trial_lines FOR EACH ROW EXECUTE FUNCTION lite_reject_change('planning record immutable');
CREATE TRIGGER planning_trial_lines_no_delete BEFORE DELETE ON planning_trial_lines FOR EACH ROW EXECUTE FUNCTION lite_reject_change('planning record immutable');
CREATE TABLE planning_trial_investments (
  id bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  org_id bigint NOT NULL,
  version_id bigint NOT NULL,
  seq bigint NOT NULL CHECK (lite_typeof(seq) = 'integer' AND seq BETWEEN 1 AND 100),
  month text COLLATE "C" NOT NULL CHECK (length(month) = 7 AND substr(month, 5, 1) = '-' AND ltrim(substr(month, 1, 4) || substr(month, 6, 2), '0123456789') = '' AND substr(month, 6, 2) BETWEEN '01' AND '12'),
  amount_yen bigint NOT NULL CHECK (lite_typeof(amount_yen) = 'integer' AND amount_yen BETWEEN 1 AND 1000000000000),
  UNIQUE (org_id, version_id, seq)
);
CREATE TRIGGER planning_trial_investments_no_update BEFORE UPDATE ON planning_trial_investments FOR EACH ROW EXECUTE FUNCTION lite_reject_change('planning record immutable');
CREATE TRIGGER planning_trial_investments_no_delete BEFORE DELETE ON planning_trial_investments FOR EACH ROW EXECUTE FUNCTION lite_reject_change('planning record immutable');
CREATE TABLE project_owner_versions (
  id bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  org_id bigint NOT NULL,
  project_id bigint NOT NULL,
  revision bigint NOT NULL CHECK (lite_typeof(revision) = 'integer' AND revision > 0),
  user_id bigint NOT NULL,
  started_on text COLLATE "C" NOT NULL CHECK (length(started_on) = 10 AND substr(started_on, 5, 1) = '-' AND substr(started_on, 8, 1) = '-' AND ltrim(substr(started_on, 1, 4) || substr(started_on, 6, 2) || substr(started_on, 9, 2), '0123456789') = ''),
  reason text COLLATE "C" NOT NULL CHECK (length(trim(reason)) BETWEEN 1 AND 1000),
  created_by bigint NOT NULL,
  created_at text COLLATE "C" NOT NULL DEFAULT to_char(statement_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS'),
  UNIQUE (org_id, id),
  UNIQUE (org_id, project_id, revision)
);
CREATE FUNCTION project_owner_versions_sequence_fn() RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  IF (NEW.revision <> (SELECT COALESCE(max(v.revision), 0) + 1 FROM project_owner_versions v WHERE v.org_id = NEW.org_id AND v.project_id = NEW.project_id)) IS NOT TRUE THEN RETURN NEW; END IF;
  RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'stale project owner';
  RETURN NEW;
END
$fn$;
CREATE TRIGGER project_owner_versions_sequence BEFORE INSERT ON project_owner_versions FOR EACH ROW EXECUTE FUNCTION project_owner_versions_sequence_fn();
CREATE TRIGGER project_owner_versions_no_update BEFORE UPDATE ON project_owner_versions FOR EACH ROW EXECUTE FUNCTION lite_reject_change('planning record immutable');
CREATE TRIGGER project_owner_versions_no_delete BEFORE DELETE ON project_owner_versions FOR EACH ROW EXECUTE FUNCTION lite_reject_change('planning record immutable');
CREATE INDEX project_owner_versions_user_idx ON project_owner_versions (org_id, user_id);
CREATE INDEX project_owner_versions_author_idx ON project_owner_versions (org_id, created_by);
CREATE TABLE planning_materials (
  id bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  org_id bigint NOT NULL,
  project_id bigint NOT NULL,
  kind text COLLATE "C" NOT NULL CHECK (kind IN ('similar', 'market', 'own_record', 'cast', 'director', 'world', 'story', 'title', 'report', 'other')),
  title text COLLATE "C" NOT NULL CHECK (length(trim(title)) BETWEEN 1 AND 240),
  label text COLLATE "C" NOT NULL CHECK (label IN ('confirmed', 'probable', 'unknown')),
  source text COLLATE "C" CHECK (source IS NULL OR length(trim(source)) BETWEEN 1 AND 1000),
  url text COLLATE "C" CHECK (url IS NULL OR (length(url) BETWEEN 8 AND 2000 AND (substr(url, 1, 8) = 'https://' OR substr(url, 1, 7) = 'http://'))),
  document_id bigint,
  acquired_on text COLLATE "C" CHECK (acquired_on IS NULL OR (length(acquired_on) = 10 AND substr(acquired_on, 5, 1) = '-' AND substr(acquired_on, 8, 1) = '-' AND ltrim(substr(acquired_on, 1, 4) || substr(acquired_on, 6, 2) || substr(acquired_on, 9, 2), '0123456789') = '')),
  created_by bigint NOT NULL,
  created_at text COLLATE "C" NOT NULL DEFAULT to_char(statement_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS'),
  UNIQUE (org_id, id),
  UNIQUE (org_id, project_id, id)
);
CREATE TRIGGER planning_materials_no_update BEFORE UPDATE ON planning_materials FOR EACH ROW EXECUTE FUNCTION lite_reject_change('planning record immutable');
CREATE TRIGGER planning_materials_no_delete BEFORE DELETE ON planning_materials FOR EACH ROW EXECUTE FUNCTION lite_reject_change('planning record immutable');
CREATE INDEX planning_materials_document_idx ON planning_materials (org_id, document_id);
CREATE INDEX planning_materials_author_idx ON planning_materials (org_id, created_by);
CREATE TABLE planning_facts (
  id bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  org_id bigint NOT NULL,
  project_id bigint NOT NULL,
  material_id bigint,
  body text COLLATE "C" NOT NULL CHECK (length(trim(body)) BETWEEN 1 AND 2000),
  value_int bigint CHECK (value_int IS NULL OR lite_typeof(value_int) = 'integer'),
  label text COLLATE "C" NOT NULL CHECK (label IN ('confirmed', 'probable', 'unknown')),
  target text COLLATE "C" NOT NULL CHECK (target IN ('deck_text', 'trial', 'team', 'case')),
  pages text COLLATE "C" NOT NULL CHECK (length(pages) BETWEEN 1 AND 200 AND ltrim(pages, '0123456789,') = ''),
  state text COLLATE "C" NOT NULL CHECK (state IN ('ai_draft', 'human_confirmed')),
  previous_id bigint,
  created_by bigint NOT NULL,
  created_at text COLLATE "C" NOT NULL DEFAULT to_char(statement_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS'),
  UNIQUE (org_id, id),
  UNIQUE (org_id, project_id, id),
  UNIQUE (org_id, previous_id)
);
CREATE TRIGGER planning_facts_no_update BEFORE UPDATE ON planning_facts FOR EACH ROW EXECUTE FUNCTION lite_reject_change('planning record immutable');
CREATE TRIGGER planning_facts_no_delete BEFORE DELETE ON planning_facts FOR EACH ROW EXECUTE FUNCTION lite_reject_change('planning record immutable');
CREATE INDEX planning_facts_project_idx ON planning_facts (org_id, project_id);
CREATE INDEX planning_facts_author_idx ON planning_facts (org_id, created_by);

-- ===== 0051_shooting_day_records.sql =====
CREATE TABLE shooting_scene_results (
  id bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  org_id bigint NOT NULL,
  project_id bigint NOT NULL,
  work_id bigint NOT NULL,
  shooting_day_id bigint NOT NULL,
  scene_id bigint NOT NULL,
  seq bigint NOT NULL CHECK (lite_typeof(seq) = 'integer' AND seq > 0),
  result text COLLATE "C" NOT NULL CHECK (result IN ('shot', 'partial', 'postponed', 'dropped')),
  postponed_to_day_id bigint,
  actual_start text COLLATE "C" CHECK (actual_start IS NULL OR (length(actual_start) = 5 AND substr(actual_start, 3, 1) = ':' AND ltrim(substr(actual_start, 1, 2) || substr(actual_start, 4, 2), '0123456789') = '' AND substr(actual_start, 1, 2) <= '29' AND substr(actual_start, 4, 2) <= '59')),
  actual_end text COLLATE "C" CHECK (actual_end IS NULL OR (length(actual_end) = 5 AND substr(actual_end, 3, 1) = ':' AND ltrim(substr(actual_end, 1, 2) || substr(actual_end, 4, 2), '0123456789') = '' AND substr(actual_end, 1, 2) <= '29' AND substr(actual_end, 4, 2) <= '59')),
  note text COLLATE "C" CHECK (note IS NULL OR length(trim(note)) BETWEEN 1 AND 1000),
  created_by bigint NOT NULL,
  created_at text COLLATE "C" NOT NULL DEFAULT to_char(statement_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS'),
  UNIQUE (org_id, id),
  UNIQUE (org_id, shooting_day_id, scene_id, seq),
  CHECK (result = 'postponed' OR postponed_to_day_id IS NULL),
  CHECK (postponed_to_day_id IS NULL OR postponed_to_day_id <> shooting_day_id),
  CHECK (actual_start IS NULL OR actual_end IS NULL OR actual_end > actual_start)
);
CREATE FUNCTION shooting_scene_results_sequence_fn() RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  IF (NEW.seq <> (SELECT COALESCE(max(r.seq), 0) + 1 FROM shooting_scene_results r WHERE r.org_id = NEW.org_id AND r.shooting_day_id = NEW.shooting_day_id AND r.scene_id = NEW.scene_id)) IS NOT TRUE THEN RETURN NEW; END IF;
  RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'stale shooting scene result';
  RETURN NEW;
END
$fn$;
CREATE TRIGGER shooting_scene_results_sequence BEFORE INSERT ON shooting_scene_results FOR EACH ROW EXECUTE FUNCTION shooting_scene_results_sequence_fn();
CREATE TRIGGER shooting_scene_results_no_update BEFORE UPDATE ON shooting_scene_results FOR EACH ROW EXECUTE FUNCTION lite_reject_change('shooting record immutable');
CREATE TRIGGER shooting_scene_results_no_delete BEFORE DELETE ON shooting_scene_results FOR EACH ROW EXECUTE FUNCTION lite_reject_change('shooting record immutable');
CREATE INDEX shooting_scene_results_work_idx ON shooting_scene_results (org_id, work_id, shooting_day_id);
CREATE INDEX shooting_scene_results_scene_idx ON shooting_scene_results (org_id, work_id, scene_id);
CREATE INDEX shooting_scene_results_moved_idx ON shooting_scene_results (org_id, work_id, postponed_to_day_id);
CREATE INDEX shooting_scene_results_author_idx ON shooting_scene_results (org_id, created_by);
CREATE TABLE shooting_day_records (
  id bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  org_id bigint NOT NULL,
  project_id bigint NOT NULL,
  work_id bigint NOT NULL,
  shooting_day_id bigint NOT NULL,
  kind text COLLATE "C" NOT NULL CHECK (kind IN ('schedule', 'ad', 'art', 'camera', 'sound', 'production', 'script')),
  seq bigint NOT NULL CHECK (lite_typeof(seq) = 'integer' AND seq > 0),
  status text COLLATE "C" NOT NULL CHECK (status IN ('placed', 'not_needed')),
  source_document_id bigint,
  reason text COLLATE "C" CHECK (reason IS NULL OR length(trim(reason)) BETWEEN 1 AND 500),
  created_by bigint NOT NULL,
  created_at text COLLATE "C" NOT NULL DEFAULT to_char(statement_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS'),
  UNIQUE (org_id, id),
  UNIQUE (org_id, shooting_day_id, kind, seq),
  UNIQUE (org_id, shooting_day_id, kind, source_document_id),
  CHECK ((status = 'placed' AND source_document_id IS NOT NULL AND reason IS NULL) OR (status = 'not_needed' AND source_document_id IS NULL AND reason IS NOT NULL))
);
CREATE FUNCTION shooting_day_records_sequence_fn() RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  IF (NEW.seq <> (SELECT COALESCE(max(r.seq), 0) + 1 FROM shooting_day_records r WHERE r.org_id = NEW.org_id AND r.shooting_day_id = NEW.shooting_day_id AND r.kind = NEW.kind)) IS NOT TRUE THEN RETURN NEW; END IF;
  RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'stale shooting day record';
  RETURN NEW;
END
$fn$;
CREATE TRIGGER shooting_day_records_sequence BEFORE INSERT ON shooting_day_records FOR EACH ROW EXECUTE FUNCTION shooting_day_records_sequence_fn();
CREATE TRIGGER shooting_day_records_no_update BEFORE UPDATE ON shooting_day_records FOR EACH ROW EXECUTE FUNCTION lite_reject_change('shooting record immutable');
CREATE TRIGGER shooting_day_records_no_delete BEFORE DELETE ON shooting_day_records FOR EACH ROW EXECUTE FUNCTION lite_reject_change('shooting record immutable');
CREATE INDEX shooting_day_records_work_idx ON shooting_day_records (org_id, work_id, shooting_day_id);
CREATE INDEX shooting_day_records_author_idx ON shooting_day_records (org_id, created_by);
CREATE INDEX shooting_day_records_document_idx ON shooting_day_records (org_id, source_document_id);
CREATE TABLE shooting_day_report_items (
  id bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  org_id bigint NOT NULL,
  project_id bigint NOT NULL,
  work_id bigint NOT NULL,
  shooting_day_id bigint NOT NULL,
  department text COLLATE "C" NOT NULL CHECK (department IN ('ad', 'art', 'camera', 'sound', 'production')),
  item_type text COLLATE "C" NOT NULL CHECK (item_type IN ('handover', 'problem', 'incident', 'expense_hint', 'other')),
  status text COLLATE "C" NOT NULL CHECK (status IN ('active', 'withdrawn')),
  body text COLLATE "C" CHECK (body IS NULL OR length(trim(body)) BETWEEN 1 AND 2000),
  scene_id bigint,
  record_id bigint,
  replaces_id bigint,
  created_by bigint NOT NULL,
  created_at text COLLATE "C" NOT NULL DEFAULT to_char(statement_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS'),
  UNIQUE (org_id, id),
  UNIQUE (org_id, replaces_id),
  CHECK ((status = 'active' AND body IS NOT NULL) OR (status = 'withdrawn' AND body IS NULL AND replaces_id IS NOT NULL))
);
CREATE FUNCTION shooting_day_report_items_same_day_fn() RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  IF (NEW.replaces_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM shooting_day_report_items p WHERE p.org_id = NEW.org_id AND p.id = NEW.replaces_id AND p.shooting_day_id = NEW.shooting_day_id AND p.department = NEW.department AND p.status = 'active')) IS NOT TRUE THEN RETURN NEW; END IF;
  RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'report item replaces another day';
  RETURN NEW;
END
$fn$;
CREATE TRIGGER shooting_day_report_items_same_day BEFORE INSERT ON shooting_day_report_items FOR EACH ROW EXECUTE FUNCTION shooting_day_report_items_same_day_fn();
CREATE FUNCTION shooting_day_report_items_record_fn() RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  IF (NEW.record_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM shooting_day_records r WHERE r.org_id = NEW.org_id AND r.id = NEW.record_id AND r.shooting_day_id = NEW.shooting_day_id AND r.kind = NEW.department AND r.status = 'placed')) IS NOT TRUE THEN RETURN NEW; END IF;
  RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'report item record mismatch';
  RETURN NEW;
END
$fn$;
CREATE TRIGGER shooting_day_report_items_record BEFORE INSERT ON shooting_day_report_items FOR EACH ROW EXECUTE FUNCTION shooting_day_report_items_record_fn();
CREATE TRIGGER shooting_day_report_items_no_update BEFORE UPDATE ON shooting_day_report_items FOR EACH ROW EXECUTE FUNCTION lite_reject_change('shooting record immutable');
CREATE TRIGGER shooting_day_report_items_no_delete BEFORE DELETE ON shooting_day_report_items FOR EACH ROW EXECUTE FUNCTION lite_reject_change('shooting record immutable');
CREATE INDEX shooting_day_report_items_work_idx ON shooting_day_report_items (org_id, work_id, shooting_day_id);
CREATE INDEX shooting_day_report_items_scene_idx ON shooting_day_report_items (org_id, work_id, scene_id);
CREATE INDEX shooting_day_report_items_record_idx ON shooting_day_report_items (org_id, record_id);
CREATE INDEX shooting_day_report_items_author_idx ON shooting_day_report_items (org_id, created_by);

-- ===== 0052_chotatsu.sql =====
CREATE TABLE chotatsu_cases (
  id bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  org_id bigint NOT NULL,
  case_code text COLLATE "C" NOT NULL CHECK (length(trim(case_code)) BETWEEN 1 AND 40),
  created_by bigint NOT NULL,
  created_at text COLLATE "C" NOT NULL DEFAULT to_char(statement_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS'),
  UNIQUE (org_id, id),
  UNIQUE (org_id, case_code)
);
CREATE TRIGGER chotatsu_cases_no_update BEFORE UPDATE ON chotatsu_cases FOR EACH ROW EXECUTE FUNCTION lite_reject_change('chotatsu record immutable');
CREATE TRIGGER chotatsu_cases_no_delete BEFORE DELETE ON chotatsu_cases FOR EACH ROW EXECUTE FUNCTION lite_reject_change('chotatsu record immutable');
CREATE TABLE chotatsu_case_versions (
  id bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  org_id bigint NOT NULL,
  case_id bigint NOT NULL,
  version_no bigint NOT NULL CHECK (lite_typeof(version_no) = 'integer' AND version_no > 0),
  title text COLLATE "C" NOT NULL CHECK (length(trim(title)) BETWEEN 1 AND 200),
  holder_partner_id bigint,
  distributor_partner_id bigint,
  media_family text COLLATE "C" NOT NULL CHECK (media_family IN ('videogram', 'digital', 'broadcast', 'overseas', 'other')),
  work_id bigint,
  origin text COLLATE "C" NOT NULL CHECK (origin IN ('self', 'sales_activity')),
  sales_activity_id bigint,
  theatrical_release_on text COLLATE "C" CHECK (theatrical_release_on IS NULL OR (length(theatrical_release_on) = 10 AND substr(theatrical_release_on, 5, 1) = '-' AND substr(theatrical_release_on, 8, 1) = '-' AND ltrim(substr(theatrical_release_on, 1, 4) || substr(theatrical_release_on, 6, 2) || substr(theatrical_release_on, 9, 2), '0123456789') = '')),
  offer_from text COLLATE "C" CHECK (offer_from IS NULL OR (length(offer_from) = 10 AND substr(offer_from, 5, 1) = '-' AND substr(offer_from, 8, 1) = '-' AND ltrim(substr(offer_from, 1, 4) || substr(offer_from, 6, 2) || substr(offer_from, 9, 2), '0123456789') = '')),
  offer_until text COLLATE "C" CHECK (offer_until IS NULL OR (length(offer_until) = 10 AND substr(offer_until, 5, 1) = '-' AND substr(offer_until, 8, 1) = '-' AND ltrim(substr(offer_until, 1, 4) || substr(offer_until, 6, 2) || substr(offer_until, 9, 2), '0123456789') = '')),
  release_month text COLLATE "C" CHECK (release_month IS NULL OR (length(release_month) = 7 AND substr(release_month, 5, 1) = '-' AND ltrim(substr(release_month, 1, 4) || substr(release_month, 6, 2), '0123456789') = '' AND substr(release_month, 6, 2) BETWEEN '01' AND '12')),
  release_slot text COLLATE "C" CHECK (release_slot IS NULL OR release_slot IN ('day25', 'first_wed', 'other')),
  note text COLLATE "C" CHECK (note IS NULL OR length(trim(note)) BETWEEN 1 AND 2000),
  reason text COLLATE "C" NOT NULL CHECK (length(trim(reason)) BETWEEN 1 AND 1000),
  created_by bigint NOT NULL,
  created_at text COLLATE "C" NOT NULL DEFAULT to_char(statement_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS'),
  UNIQUE (org_id, id),
  UNIQUE (org_id, case_id, version_no),
  CHECK ((origin = 'self' AND sales_activity_id IS NULL) OR (origin = 'sales_activity' AND sales_activity_id IS NOT NULL)),
  CHECK (offer_from IS NULL OR offer_until IS NULL OR offer_until >= offer_from),
  CHECK (release_slot IS NULL OR release_month IS NOT NULL)
);
CREATE FUNCTION chotatsu_case_versions_sequence_fn() RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  IF (NEW.version_no <> (SELECT COALESCE(max(v.version_no), 0) + 1 FROM chotatsu_case_versions v WHERE v.org_id = NEW.org_id AND v.case_id = NEW.case_id)) IS NOT TRUE THEN RETURN NEW; END IF;
  RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'stale chotatsu version';
  RETURN NEW;
END
$fn$;
CREATE TRIGGER chotatsu_case_versions_sequence BEFORE INSERT ON chotatsu_case_versions FOR EACH ROW EXECUTE FUNCTION chotatsu_case_versions_sequence_fn();
CREATE TRIGGER chotatsu_case_versions_no_update BEFORE UPDATE ON chotatsu_case_versions FOR EACH ROW EXECUTE FUNCTION lite_reject_change('chotatsu record immutable');
CREATE TRIGGER chotatsu_case_versions_no_delete BEFORE DELETE ON chotatsu_case_versions FOR EACH ROW EXECUTE FUNCTION lite_reject_change('chotatsu record immutable');
CREATE INDEX chotatsu_case_versions_case_idx ON chotatsu_case_versions (org_id, case_id);
CREATE TABLE chotatsu_stage_events (
  id bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  org_id bigint NOT NULL,
  case_id bigint NOT NULL,
  seq bigint NOT NULL CHECK (lite_typeof(seq) = 'integer' AND seq > 0),
  stage text COLLATE "C" NOT NULL CHECK (stage IN ('wish', 'estimate', 'agreement', 'ringi', 'contract', 'materials', 'handoff')),
  event text COLLATE "C" NOT NULL CHECK (event IN ('done', 'void', 'dropped', 'moved_to_mg')),
  voids_seq bigint CHECK (voids_seq IS NULL OR (lite_typeof(voids_seq) = 'integer' AND voids_seq > 0)),
  on_date text COLLATE "C" NOT NULL CHECK (length(on_date) = 10 AND substr(on_date, 5, 1) = '-' AND substr(on_date, 8, 1) = '-' AND ltrim(substr(on_date, 1, 4) || substr(on_date, 6, 2) || substr(on_date, 9, 2), '0123456789') = ''),
  reason text COLLATE "C" CHECK (reason IS NULL OR length(trim(reason)) BETWEEN 1 AND 1000),
  created_by bigint NOT NULL,
  created_at text COLLATE "C" NOT NULL DEFAULT to_char(statement_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS'),
  UNIQUE (org_id, id),
  UNIQUE (org_id, case_id, seq),
  CHECK ((event = 'void' AND voids_seq IS NOT NULL AND voids_seq < seq AND reason IS NOT NULL) OR (event <> 'void' AND voids_seq IS NULL)),
  CHECK (event NOT IN ('dropped', 'moved_to_mg') OR reason IS NOT NULL)
);
CREATE FUNCTION chotatsu_stage_events_sequence_fn() RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  IF (NEW.seq <> (SELECT COALESCE(max(e.seq), 0) + 1 FROM chotatsu_stage_events e WHERE e.org_id = NEW.org_id AND e.case_id = NEW.case_id)) IS NOT TRUE THEN RETURN NEW; END IF;
  RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'stale chotatsu event';
  RETURN NEW;
END
$fn$;
CREATE TRIGGER chotatsu_stage_events_sequence BEFORE INSERT ON chotatsu_stage_events FOR EACH ROW EXECUTE FUNCTION chotatsu_stage_events_sequence_fn();
CREATE FUNCTION chotatsu_stage_events_closed_fn() RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  IF (NEW.event <> 'void' AND EXISTS (SELECT 1 FROM chotatsu_stage_events e WHERE e.org_id = NEW.org_id AND e.case_id = NEW.case_id AND e.event IN ('dropped', 'moved_to_mg') AND NOT EXISTS (SELECT 1 FROM chotatsu_stage_events x WHERE x.org_id = e.org_id AND x.case_id = e.case_id AND x.event = 'void' AND x.voids_seq = e.seq))) IS NOT TRUE THEN RETURN NEW; END IF;
  RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'chotatsu case closed';
  RETURN NEW;
END
$fn$;
CREATE TRIGGER chotatsu_stage_events_closed BEFORE INSERT ON chotatsu_stage_events FOR EACH ROW EXECUTE FUNCTION chotatsu_stage_events_closed_fn();
CREATE FUNCTION chotatsu_stage_events_void_target_fn() RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  IF (NEW.event = 'void' AND (NOT EXISTS (SELECT 1 FROM chotatsu_stage_events e WHERE e.org_id = NEW.org_id AND e.case_id = NEW.case_id AND e.seq = NEW.voids_seq AND e.event <> 'void' AND e.stage = NEW.stage) OR EXISTS (SELECT 1 FROM chotatsu_stage_events x WHERE x.org_id = NEW.org_id AND x.case_id = NEW.case_id AND x.event = 'void' AND x.voids_seq = NEW.voids_seq))) IS NOT TRUE THEN RETURN NEW; END IF;
  RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'chotatsu void target invalid';
  RETURN NEW;
END
$fn$;
CREATE TRIGGER chotatsu_stage_events_void_target BEFORE INSERT ON chotatsu_stage_events FOR EACH ROW EXECUTE FUNCTION chotatsu_stage_events_void_target_fn();
CREATE TRIGGER chotatsu_stage_events_no_update BEFORE UPDATE ON chotatsu_stage_events FOR EACH ROW EXECUTE FUNCTION lite_reject_change('chotatsu record immutable');
CREATE TRIGGER chotatsu_stage_events_no_delete BEFORE DELETE ON chotatsu_stage_events FOR EACH ROW EXECUTE FUNCTION lite_reject_change('chotatsu record immutable');
CREATE TABLE chotatsu_estimates (
  id bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  org_id bigint NOT NULL,
  case_id bigint NOT NULL,
  version_no bigint NOT NULL CHECK (lite_typeof(version_no) = 'integer' AND version_no > 0),
  format text COLLATE "C" NOT NULL CHECK (format IN ('sell_dvd', 'sell_bd', 'sell_dvd_bd', 'rental_dvd', 'rental_bd', 'digital', 'other')),
  set_count bigint NOT NULL CHECK (lite_typeof(set_count) = 'integer' AND set_count BETWEEN 1 AND 100),
  bonus_note text COLLATE "C" CHECK (bonus_note IS NULL OR length(trim(bonus_note)) BETWEEN 1 AND 500),
  list_price_ex_tax_yen bigint CHECK (list_price_ex_tax_yen IS NULL OR (lite_typeof(list_price_ex_tax_yen) = 'integer' AND list_price_ex_tax_yen BETWEEN 0 AND 1000000000)),
  unit_revenue_ex_tax_yen bigint NOT NULL CHECK (lite_typeof(unit_revenue_ex_tax_yen) = 'integer' AND unit_revenue_ex_tax_yen BETWEEN 0 AND 1000000000),
  quantity bigint NOT NULL CHECK (lite_typeof(quantity) = 'integer' AND quantity BETWEEN 0 AND 100000000),
  royalty_kind text COLLATE "C" NOT NULL CHECK (royalty_kind IN ('rate', 'per_unit', 'none')),
  royalty_rate_bps bigint CHECK (royalty_rate_bps IS NULL OR (lite_typeof(royalty_rate_bps) = 'integer' AND royalty_rate_bps BETWEEN 0 AND 10000)),
  royalty_per_unit_yen bigint CHECK (royalty_per_unit_yen IS NULL OR (lite_typeof(royalty_per_unit_yen) = 'integer' AND royalty_per_unit_yen BETWEEN 0 AND 1000000000)),
  promotion_note text COLLATE "C" CHECK (promotion_note IS NULL OR length(trim(promotion_note)) BETWEEN 1 AND 2000),
  reason text COLLATE "C" NOT NULL CHECK (length(trim(reason)) BETWEEN 1 AND 1000),
  created_by bigint NOT NULL,
  created_at text COLLATE "C" NOT NULL DEFAULT to_char(statement_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS'),
  UNIQUE (org_id, id),
  UNIQUE (org_id, case_id, id),
  UNIQUE (org_id, case_id, version_no),
  CHECK ((royalty_kind = 'rate' AND royalty_rate_bps IS NOT NULL AND royalty_per_unit_yen IS NULL) OR (royalty_kind = 'per_unit' AND royalty_per_unit_yen IS NOT NULL AND royalty_rate_bps IS NULL) OR (royalty_kind = 'none' AND royalty_rate_bps IS NULL AND royalty_per_unit_yen IS NULL))
);
CREATE FUNCTION chotatsu_estimates_sequence_fn() RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  IF (NEW.version_no <> (SELECT COALESCE(max(v.version_no), 0) + 1 FROM chotatsu_estimates v WHERE v.org_id = NEW.org_id AND v.case_id = NEW.case_id)) IS NOT TRUE THEN RETURN NEW; END IF;
  RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'stale chotatsu estimate';
  RETURN NEW;
END
$fn$;
CREATE TRIGGER chotatsu_estimates_sequence BEFORE INSERT ON chotatsu_estimates FOR EACH ROW EXECUTE FUNCTION chotatsu_estimates_sequence_fn();
CREATE TRIGGER chotatsu_estimates_no_update BEFORE UPDATE ON chotatsu_estimates FOR EACH ROW EXECUTE FUNCTION lite_reject_change('chotatsu record immutable');
CREATE TRIGGER chotatsu_estimates_no_delete BEFORE DELETE ON chotatsu_estimates FOR EACH ROW EXECUTE FUNCTION lite_reject_change('chotatsu record immutable');
CREATE TABLE chotatsu_estimate_lines (
  id bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  org_id bigint NOT NULL,
  case_id bigint NOT NULL,
  estimate_id bigint NOT NULL,
  line_no bigint NOT NULL CHECK (lite_typeof(line_no) = 'integer' AND line_no BETWEEN 1 AND 200),
  expense_type text COLLATE "C" NOT NULL CHECK (length(trim(expense_type)) BETWEEN 1 AND 60),
  name text COLLATE "C" NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 200),
  amount_ex_tax_yen bigint NOT NULL CHECK (lite_typeof(amount_ex_tax_yen) = 'integer' AND amount_ex_tax_yen BETWEEN 0 AND 1000000000000),
  source_document_id bigint,
  UNIQUE (org_id, id),
  UNIQUE (org_id, estimate_id, line_no)
);
CREATE TRIGGER chotatsu_estimate_lines_no_update BEFORE UPDATE ON chotatsu_estimate_lines FOR EACH ROW EXECUTE FUNCTION lite_reject_change('chotatsu record immutable');
CREATE TRIGGER chotatsu_estimate_lines_no_delete BEFORE DELETE ON chotatsu_estimate_lines FOR EACH ROW EXECUTE FUNCTION lite_reject_change('chotatsu record immutable');
CREATE INDEX chotatsu_estimate_lines_estimate_idx ON chotatsu_estimate_lines (org_id, estimate_id);
CREATE TABLE chotatsu_agreements (
  id bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  org_id bigint NOT NULL,
  case_id bigint NOT NULL,
  estimate_id bigint NOT NULL,
  agreed_on text COLLATE "C" NOT NULL CHECK (length(agreed_on) = 10 AND substr(agreed_on, 5, 1) = '-' AND substr(agreed_on, 8, 1) = '-' AND ltrim(substr(agreed_on, 1, 4) || substr(agreed_on, 6, 2) || substr(agreed_on, 9, 2), '0123456789') = ''),
  source_document_id bigint,
  created_by bigint NOT NULL,
  created_at text COLLATE "C" NOT NULL DEFAULT to_char(statement_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS'),
  UNIQUE (org_id, id)
);
CREATE TRIGGER chotatsu_agreements_no_update BEFORE UPDATE ON chotatsu_agreements FOR EACH ROW EXECUTE FUNCTION lite_reject_change('chotatsu record immutable');
CREATE TRIGGER chotatsu_agreements_no_delete BEFORE DELETE ON chotatsu_agreements FOR EACH ROW EXECUTE FUNCTION lite_reject_change('chotatsu record immutable');
CREATE INDEX chotatsu_agreements_case_idx ON chotatsu_agreements (org_id, case_id);
CREATE TABLE chotatsu_ringi (
  id bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  org_id bigint NOT NULL,
  case_id bigint NOT NULL,
  estimate_id bigint NOT NULL,
  result text COLLATE "C" NOT NULL CHECK (result IN ('approved', 'returned', 'rejected')),
  result_on text COLLATE "C" NOT NULL CHECK (length(result_on) = 10 AND substr(result_on, 5, 1) = '-' AND substr(result_on, 8, 1) = '-' AND ltrim(substr(result_on, 1, 4) || substr(result_on, 6, 2) || substr(result_on, 9, 2), '0123456789') = ''),
  source_document_id bigint,
  note text COLLATE "C" CHECK (note IS NULL OR length(trim(note)) BETWEEN 1 AND 1000),
  created_by bigint NOT NULL,
  created_at text COLLATE "C" NOT NULL DEFAULT to_char(statement_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS'),
  UNIQUE (org_id, id)
);
CREATE TRIGGER chotatsu_ringi_no_update BEFORE UPDATE ON chotatsu_ringi FOR EACH ROW EXECUTE FUNCTION lite_reject_change('chotatsu record immutable');
CREATE TRIGGER chotatsu_ringi_no_delete BEFORE DELETE ON chotatsu_ringi FOR EACH ROW EXECUTE FUNCTION lite_reject_change('chotatsu record immutable');
CREATE INDEX chotatsu_ringi_case_idx ON chotatsu_ringi (org_id, case_id);
CREATE TABLE chotatsu_contracts (
  id bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  org_id bigint NOT NULL,
  case_id bigint NOT NULL,
  intake_case_id bigint NOT NULL,
  work_id bigint NOT NULL,
  settlement_contract_id bigint NOT NULL,
  signed_on text COLLATE "C" NOT NULL CHECK (length(signed_on) = 10 AND substr(signed_on, 5, 1) = '-' AND substr(signed_on, 8, 1) = '-' AND ltrim(substr(signed_on, 1, 4) || substr(signed_on, 6, 2) || substr(signed_on, 9, 2), '0123456789') = ''),
  signed_document_id bigint,
  created_by bigint NOT NULL,
  created_at text COLLATE "C" NOT NULL DEFAULT to_char(statement_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS'),
  UNIQUE (org_id, id),
  UNIQUE (org_id, intake_case_id),
  UNIQUE (org_id, settlement_contract_id)
);
CREATE TRIGGER chotatsu_contracts_no_update BEFORE UPDATE ON chotatsu_contracts FOR EACH ROW EXECUTE FUNCTION lite_reject_change('chotatsu record immutable');
CREATE TRIGGER chotatsu_contracts_no_delete BEFORE DELETE ON chotatsu_contracts FOR EACH ROW EXECUTE FUNCTION lite_reject_change('chotatsu record immutable');
CREATE INDEX chotatsu_contracts_case_idx ON chotatsu_contracts (org_id, case_id);
CREATE TABLE chotatsu_materials (
  id bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  org_id bigint NOT NULL,
  case_id bigint NOT NULL,
  seq bigint NOT NULL CHECK (lite_typeof(seq) = 'integer' AND seq > 0),
  material_kind text COLLATE "C" NOT NULL CHECK (material_kind IN ('master', 'preview_copy', 'trailer', 'bonus', 'music', 'main_art', 'logo', 'stills', 'poster', 'work_info', 'other')),
  required bigint NOT NULL CHECK (required IN (0, 1)),
  received_on text COLLATE "C" CHECK (received_on IS NULL OR (length(received_on) = 10 AND substr(received_on, 5, 1) = '-' AND substr(received_on, 8, 1) = '-' AND ltrim(substr(received_on, 1, 4) || substr(received_on, 6, 2) || substr(received_on, 9, 2), '0123456789') = '')),
  check_result text COLLATE "C" NOT NULL CHECK (check_result IN ('pending', 'ok', 'ng')),
  source_document_id bigint,
  note text COLLATE "C" CHECK (note IS NULL OR length(trim(note)) BETWEEN 1 AND 1000),
  created_by bigint NOT NULL,
  created_at text COLLATE "C" NOT NULL DEFAULT to_char(statement_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS'),
  UNIQUE (org_id, id),
  UNIQUE (org_id, case_id, seq),
  CHECK (check_result = 'pending' OR received_on IS NOT NULL)
);
CREATE FUNCTION chotatsu_materials_sequence_fn() RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  IF (NEW.seq <> (SELECT COALESCE(max(m.seq), 0) + 1 FROM chotatsu_materials m WHERE m.org_id = NEW.org_id AND m.case_id = NEW.case_id)) IS NOT TRUE THEN RETURN NEW; END IF;
  RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'stale chotatsu material';
  RETURN NEW;
END
$fn$;
CREATE TRIGGER chotatsu_materials_sequence BEFORE INSERT ON chotatsu_materials FOR EACH ROW EXECUTE FUNCTION chotatsu_materials_sequence_fn();
CREATE TRIGGER chotatsu_materials_no_update BEFORE UPDATE ON chotatsu_materials FOR EACH ROW EXECUTE FUNCTION lite_reject_change('chotatsu record immutable');
CREATE TRIGGER chotatsu_materials_no_delete BEFORE DELETE ON chotatsu_materials FOR EACH ROW EXECUTE FUNCTION lite_reject_change('chotatsu record immutable');
CREATE TABLE chotatsu_handoffs (
  id bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  org_id bigint NOT NULL,
  case_id bigint NOT NULL,
  handoff_no bigint NOT NULL CHECK (lite_typeof(handoff_no) = 'integer' AND handoff_no > 0),
  work_id bigint NOT NULL,
  intake_case_id bigint NOT NULL,
  estimate_id bigint NOT NULL,
  allowed_formats text COLLATE "C" NOT NULL CHECK (lite_json_valid(allowed_formats) AND lite_json_type(allowed_formats) = 'array' AND length(allowed_formats) BETWEEN 2 AND 500),
  territory text COLLATE "C" CHECK (territory IS NULL OR length(trim(territory)) BETWEEN 1 AND 100),
  rights_end text COLLATE "C" CHECK (rights_end IS NULL OR (length(rights_end) = 10 AND substr(rights_end, 5, 1) = '-' AND substr(rights_end, 8, 1) = '-')),
  release_slot text COLLATE "C" NOT NULL CHECK (release_slot IN ('day25', 'first_wed', 'other')),
  release_month text COLLATE "C" NOT NULL CHECK (length(release_month) = 7 AND substr(release_month, 5, 1) = '-' AND ltrim(substr(release_month, 1, 4) || substr(release_month, 6, 2), '0123456789') = '' AND substr(release_month, 6, 2) BETWEEN '01' AND '12'),
  created_by bigint NOT NULL,
  created_at text COLLATE "C" NOT NULL DEFAULT to_char(statement_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS'),
  UNIQUE (org_id, id),
  UNIQUE (org_id, case_id, handoff_no)
);
CREATE FUNCTION chotatsu_handoffs_sequence_fn() RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  IF (NEW.handoff_no <> (SELECT COALESCE(max(h.handoff_no), 0) + 1 FROM chotatsu_handoffs h WHERE h.org_id = NEW.org_id AND h.case_id = NEW.case_id)) IS NOT TRUE THEN RETURN NEW; END IF;
  RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'stale chotatsu handoff';
  RETURN NEW;
END
$fn$;
CREATE TRIGGER chotatsu_handoffs_sequence BEFORE INSERT ON chotatsu_handoffs FOR EACH ROW EXECUTE FUNCTION chotatsu_handoffs_sequence_fn();
CREATE FUNCTION chotatsu_handoffs_requires_contract_fn() RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  IF (NOT EXISTS (SELECT 1 FROM chotatsu_contracts k WHERE k.org_id = NEW.org_id AND k.case_id = NEW.case_id AND k.intake_case_id = NEW.intake_case_id)) IS NOT TRUE THEN RETURN NEW; END IF;
  RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'chotatsu handoff requires contract';
  RETURN NEW;
END
$fn$;
CREATE TRIGGER chotatsu_handoffs_requires_contract BEFORE INSERT ON chotatsu_handoffs FOR EACH ROW EXECUTE FUNCTION chotatsu_handoffs_requires_contract_fn();
CREATE TRIGGER chotatsu_handoffs_no_update BEFORE UPDATE ON chotatsu_handoffs FOR EACH ROW EXECUTE FUNCTION lite_reject_change('chotatsu record immutable');
CREATE TRIGGER chotatsu_handoffs_no_delete BEFORE DELETE ON chotatsu_handoffs FOR EACH ROW EXECUTE FUNCTION lite_reject_change('chotatsu record immutable');
CREATE TABLE chotatsu_handoff_events (
  id bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  org_id bigint NOT NULL,
  handoff_id bigint NOT NULL,
  seq bigint NOT NULL CHECK (lite_typeof(seq) = 'integer' AND seq > 0),
  event text COLLATE "C" NOT NULL CHECK (event IN ('notice', 'received', 'void')),
  reason text COLLATE "C" CHECK (reason IS NULL OR length(trim(reason)) BETWEEN 1 AND 1000),
  created_by bigint NOT NULL,
  created_at text COLLATE "C" NOT NULL DEFAULT to_char(statement_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS'),
  UNIQUE (org_id, id),
  UNIQUE (org_id, handoff_id, seq),
  CHECK (event <> 'void' OR reason IS NOT NULL)
);
CREATE FUNCTION chotatsu_handoff_events_sequence_fn() RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  IF (NEW.seq <> (SELECT COALESCE(max(e.seq), 0) + 1 FROM chotatsu_handoff_events e WHERE e.org_id = NEW.org_id AND e.handoff_id = NEW.handoff_id)) IS NOT TRUE THEN RETURN NEW; END IF;
  RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'stale chotatsu handoff event';
  RETURN NEW;
END
$fn$;
CREATE TRIGGER chotatsu_handoff_events_sequence BEFORE INSERT ON chotatsu_handoff_events FOR EACH ROW EXECUTE FUNCTION chotatsu_handoff_events_sequence_fn();
CREATE FUNCTION chotatsu_handoff_events_order_fn() RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  IF ((NEW.event = 'notice' AND NEW.seq <> 1) OR (NEW.event = 'received' AND NOT EXISTS (SELECT 1 FROM chotatsu_handoff_events e WHERE e.org_id = NEW.org_id AND e.handoff_id = NEW.handoff_id AND e.event = 'notice')) OR (NEW.event = 'received' AND EXISTS (SELECT 1 FROM chotatsu_handoff_events e WHERE e.org_id = NEW.org_id AND e.handoff_id = NEW.handoff_id AND e.event = 'received')) OR EXISTS (SELECT 1 FROM chotatsu_handoff_events e WHERE e.org_id = NEW.org_id AND e.handoff_id = NEW.handoff_id AND e.event = 'void')) IS NOT TRUE THEN RETURN NEW; END IF;
  RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'chotatsu handoff event order';
  RETURN NEW;
END
$fn$;
CREATE TRIGGER chotatsu_handoff_events_order BEFORE INSERT ON chotatsu_handoff_events FOR EACH ROW EXECUTE FUNCTION chotatsu_handoff_events_order_fn();
CREATE TRIGGER chotatsu_handoff_events_no_update BEFORE UPDATE ON chotatsu_handoff_events FOR EACH ROW EXECUTE FUNCTION lite_reject_change('chotatsu record immutable');
CREATE TRIGGER chotatsu_handoff_events_no_delete BEFORE DELETE ON chotatsu_handoff_events FOR EACH ROW EXECUTE FUNCTION lite_reject_change('chotatsu record immutable');
CREATE TABLE chotatsu_documents (
  id bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  org_id bigint NOT NULL,
  case_id bigint NOT NULL,
  source_document_id bigint NOT NULL,
  doc_kind text COLLATE "C" NOT NULL CHECK (doc_kind IN ('estimate', 'agreement', 'ringi', 'contract_draft', 'contract', 'materials', 'other')),
  created_by bigint NOT NULL,
  created_at text COLLATE "C" NOT NULL DEFAULT to_char(statement_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS'),
  UNIQUE (org_id, id),
  UNIQUE (org_id, case_id, source_document_id)
);
CREATE TRIGGER chotatsu_documents_no_update BEFORE UPDATE ON chotatsu_documents FOR EACH ROW EXECUTE FUNCTION lite_reject_change('chotatsu record immutable');
CREATE TRIGGER chotatsu_documents_no_delete BEFORE DELETE ON chotatsu_documents FOR EACH ROW EXECUTE FUNCTION lite_reject_change('chotatsu record immutable');
CREATE TABLE chotatsu_case_expenses (
  id bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  org_id bigint NOT NULL,
  case_id bigint NOT NULL,
  expense_id bigint NOT NULL,
  estimate_line_id bigint,
  created_by bigint NOT NULL,
  created_at text COLLATE "C" NOT NULL DEFAULT to_char(statement_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS'),
  UNIQUE (org_id, id),
  UNIQUE (org_id, case_id, expense_id)
);
CREATE TRIGGER chotatsu_case_expenses_no_update BEFORE UPDATE ON chotatsu_case_expenses FOR EACH ROW EXECUTE FUNCTION lite_reject_change('chotatsu record immutable');
CREATE TRIGGER chotatsu_case_expenses_no_delete BEFORE DELETE ON chotatsu_case_expenses FOR EACH ROW EXECUTE FUNCTION lite_reject_change('chotatsu record immutable');

-- ===== 0053_preprod_arrangements_art.sql =====
CREATE TABLE production_arrangement_versions (
  id bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  org_id bigint NOT NULL,
  work_id bigint NOT NULL,
  arrangement_key text COLLATE "C" NOT NULL CHECK (length(arrangement_key) BETWEEN 1 AND 64),
  version_no bigint NOT NULL CHECK (lite_typeof(version_no) = 'integer' AND version_no > 0),
  kind text COLLATE "C" NOT NULL CHECK (kind IN ('camera', 'grip', 'lighting', 'sound', 'truck', 'location_bus', 'vehicle', 'other')),
  partner_id bigint,
  item text COLLATE "C" NOT NULL CHECK (length(trim(item)) BETWEEN 1 AND 200),
  quantity bigint CHECK (quantity IS NULL OR (lite_typeof(quantity) = 'integer' AND quantity BETWEEN 0 AND 100000)),
  unit text COLLATE "C" CHECK (unit IS NULL OR length(trim(unit)) BETWEEN 1 AND 20),
  capacity bigint CHECK (capacity IS NULL OR (lite_typeof(capacity) = 'integer' AND capacity BETWEEN 1 AND 1000)),
  starts_on text COLLATE "C" CHECK (starts_on IS NULL OR (length(starts_on) = 10 AND substr(starts_on, 5, 1) = '-' AND substr(starts_on, 8, 1) = '-' AND ltrim(substr(starts_on, 1, 4) || substr(starts_on, 6, 2) || substr(starts_on, 9, 2), '0123456789') = '')),
  ends_on text COLLATE "C" CHECK (ends_on IS NULL OR (length(ends_on) = 10 AND substr(ends_on, 5, 1) = '-' AND substr(ends_on, 8, 1) = '-' AND ltrim(substr(ends_on, 1, 4) || substr(ends_on, 6, 2) || substr(ends_on, 9, 2), '0123456789') = '')),
  deadline_on text COLLATE "C" CHECK (deadline_on IS NULL OR (length(deadline_on) = 10 AND substr(deadline_on, 5, 1) = '-' AND substr(deadline_on, 8, 1) = '-' AND ltrim(substr(deadline_on, 1, 4) || substr(deadline_on, 6, 2) || substr(deadline_on, 9, 2), '0123456789') = '')),
  state text COLLATE "C" NOT NULL CHECK (state IN ('hold', 'confirmed', 'cancelled')),
  note text COLLATE "C" CHECK (note IS NULL OR length(note) BETWEEN 1 AND 2000),
  created_by bigint NOT NULL,
  created_at text COLLATE "C" NOT NULL DEFAULT to_char(statement_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS'),
  UNIQUE (org_id, id),
  UNIQUE (org_id, work_id, arrangement_key, version_no),
  CHECK (ends_on IS NULL OR starts_on IS NULL OR ends_on >= starts_on)
);
CREATE FUNCTION production_arrangement_versions_sequence_fn() RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  IF (NEW.version_no <> (SELECT COALESCE(max(v.version_no), 0) + 1 FROM production_arrangement_versions v WHERE v.org_id = NEW.org_id AND v.work_id = NEW.work_id AND v.arrangement_key = NEW.arrangement_key)) IS NOT TRUE THEN RETURN NEW; END IF;
  RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'stale arrangement version';
  RETURN NEW;
END
$fn$;
CREATE TRIGGER production_arrangement_versions_sequence BEFORE INSERT ON production_arrangement_versions FOR EACH ROW EXECUTE FUNCTION production_arrangement_versions_sequence_fn();
CREATE TRIGGER production_arrangement_versions_no_update BEFORE UPDATE ON production_arrangement_versions FOR EACH ROW EXECUTE FUNCTION lite_reject_change('preprod record immutable');
CREATE TRIGGER production_arrangement_versions_no_delete BEFORE DELETE ON production_arrangement_versions FOR EACH ROW EXECUTE FUNCTION lite_reject_change('preprod record immutable');
CREATE INDEX production_arrangement_versions_work_idx ON production_arrangement_versions (org_id, work_id, arrangement_key);
CREATE INDEX production_arrangement_versions_partner_idx ON production_arrangement_versions (org_id, partner_id);
CREATE INDEX production_arrangement_versions_author_idx ON production_arrangement_versions (org_id, created_by);
CREATE TABLE scene_art_item_versions (
  id bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  org_id bigint NOT NULL,
  work_id bigint NOT NULL,
  item_key text COLLATE "C" NOT NULL CHECK (length(item_key) BETWEEN 1 AND 64),
  version_no bigint NOT NULL CHECK (lite_typeof(version_no) = 'integer' AND version_no > 0),
  scene_id bigint,
  kind text COLLATE "C" NOT NULL CHECK (kind IN ('dressing', 'prop', 'build')),
  content text COLLATE "C" NOT NULL CHECK (length(trim(content)) BETWEEN 1 AND 500),
  owner_label text COLLATE "C" CHECK (owner_label IS NULL OR length(trim(owner_label)) BETWEEN 1 AND 80),
  delivery_on text COLLATE "C" CHECK (delivery_on IS NULL OR (length(delivery_on) = 10 AND substr(delivery_on, 5, 1) = '-' AND substr(delivery_on, 8, 1) = '-' AND ltrim(substr(delivery_on, 1, 4) || substr(delivery_on, 6, 2) || substr(delivery_on, 9, 2), '0123456789') = '')),
  state text COLLATE "C" NOT NULL CHECK (state IN ('open', 'arranging', 'done', 'cancelled')),
  note text COLLATE "C" CHECK (note IS NULL OR length(note) BETWEEN 1 AND 2000),
  created_by bigint NOT NULL,
  created_at text COLLATE "C" NOT NULL DEFAULT to_char(statement_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS'),
  UNIQUE (org_id, id),
  UNIQUE (org_id, work_id, item_key, version_no)
);
CREATE FUNCTION scene_art_item_versions_sequence_fn() RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  IF (NEW.version_no <> (SELECT COALESCE(max(v.version_no), 0) + 1 FROM scene_art_item_versions v WHERE v.org_id = NEW.org_id AND v.work_id = NEW.work_id AND v.item_key = NEW.item_key)) IS NOT TRUE THEN RETURN NEW; END IF;
  RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'stale art item version';
  RETURN NEW;
END
$fn$;
CREATE TRIGGER scene_art_item_versions_sequence BEFORE INSERT ON scene_art_item_versions FOR EACH ROW EXECUTE FUNCTION scene_art_item_versions_sequence_fn();
CREATE TRIGGER scene_art_item_versions_no_update BEFORE UPDATE ON scene_art_item_versions FOR EACH ROW EXECUTE FUNCTION lite_reject_change('preprod record immutable');
CREATE TRIGGER scene_art_item_versions_no_delete BEFORE DELETE ON scene_art_item_versions FOR EACH ROW EXECUTE FUNCTION lite_reject_change('preprod record immutable');
CREATE INDEX scene_art_item_versions_work_idx ON scene_art_item_versions (org_id, work_id, item_key);
CREATE INDEX scene_art_item_versions_scene_idx ON scene_art_item_versions (org_id, work_id, scene_id);
CREATE INDEX scene_art_item_versions_author_idx ON scene_art_item_versions (org_id, created_by);
CREATE TABLE scene_shoot_plan_versions (
  id bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  org_id bigint NOT NULL,
  work_id bigint NOT NULL,
  scene_id bigint NOT NULL,
  version_no bigint NOT NULL CHECK (lite_typeof(version_no) = 'integer' AND version_no > 0),
  methods text COLLATE "C" CHECK (methods IS NULL OR length(trim(methods)) BETWEEN 1 AND 200),
  equipment text COLLATE "C" CHECK (equipment IS NULL OR length(trim(equipment)) BETWEEN 1 AND 500),
  note text COLLATE "C" CHECK (note IS NULL OR length(note) BETWEEN 1 AND 2000),
  created_by bigint NOT NULL,
  created_at text COLLATE "C" NOT NULL DEFAULT to_char(statement_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS'),
  UNIQUE (org_id, id),
  UNIQUE (org_id, work_id, scene_id, version_no)
);
CREATE FUNCTION scene_shoot_plan_versions_sequence_fn() RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  IF (NEW.version_no <> (SELECT COALESCE(max(v.version_no), 0) + 1 FROM scene_shoot_plan_versions v WHERE v.org_id = NEW.org_id AND v.work_id = NEW.work_id AND v.scene_id = NEW.scene_id)) IS NOT TRUE THEN RETURN NEW; END IF;
  RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'stale shoot plan version';
  RETURN NEW;
END
$fn$;
CREATE TRIGGER scene_shoot_plan_versions_sequence BEFORE INSERT ON scene_shoot_plan_versions FOR EACH ROW EXECUTE FUNCTION scene_shoot_plan_versions_sequence_fn();
CREATE TRIGGER scene_shoot_plan_versions_no_update BEFORE UPDATE ON scene_shoot_plan_versions FOR EACH ROW EXECUTE FUNCTION lite_reject_change('preprod record immutable');
CREATE TRIGGER scene_shoot_plan_versions_no_delete BEFORE DELETE ON scene_shoot_plan_versions FOR EACH ROW EXECUTE FUNCTION lite_reject_change('preprod record immutable');
CREATE INDEX scene_shoot_plan_versions_scene_idx ON scene_shoot_plan_versions (org_id, work_id, scene_id);
CREATE INDEX scene_shoot_plan_versions_author_idx ON scene_shoot_plan_versions (org_id, created_by);

-- ===== 0054_preprod_document_placements.sql =====
CREATE TABLE preprod_document_placements (
  id bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  org_id bigint NOT NULL,
  work_id bigint NOT NULL,
  document_id bigint NOT NULL,
  category text COLLATE "C" NOT NULL CHECK (category IN ('script', 'schedule', 'daily', 'costume', 'location', 'cast', 'still', 'design', 'contract', 'other')),
  episode text COLLATE "C" CHECK (episode IS NULL OR length(trim(episode)) BETWEEN 1 AND 40),
  dated_on text COLLATE "C" CHECK (dated_on IS NULL OR (length(dated_on) = 10 AND substr(dated_on, 5, 1) = '-' AND substr(dated_on, 8, 1) = '-' AND ltrim(substr(dated_on, 1, 4) || substr(dated_on, 6, 2) || substr(dated_on, 9, 2), '0123456789') = '')),
  origin_path text COLLATE "C" CHECK (origin_path IS NULL OR length(trim(origin_path)) BETWEEN 1 AND 500),
  shooting_day_id bigint,
  scene_id bigint,
  note text COLLATE "C" CHECK (note IS NULL OR length(note) BETWEEN 1 AND 2000),
  placed_by bigint NOT NULL,
  created_at text COLLATE "C" NOT NULL DEFAULT to_char(statement_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS'),
  UNIQUE (org_id, id)
);
CREATE TRIGGER preprod_document_placements_no_update BEFORE UPDATE ON preprod_document_placements FOR EACH ROW EXECUTE FUNCTION lite_reject_change('preprod record immutable');
CREATE TRIGGER preprod_document_placements_no_delete BEFORE DELETE ON preprod_document_placements FOR EACH ROW EXECUTE FUNCTION lite_reject_change('preprod record immutable');
CREATE INDEX preprod_document_placements_work_idx ON preprod_document_placements (org_id, work_id, document_id);
CREATE INDEX preprod_document_placements_document_idx ON preprod_document_placements (org_id, document_id);
CREATE INDEX preprod_document_placements_day_idx ON preprod_document_placements (org_id, work_id, shooting_day_id);
CREATE INDEX preprod_document_placements_scene_idx ON preprod_document_placements (org_id, work_id, scene_id);
CREATE INDEX preprod_document_placements_author_idx ON preprod_document_placements (org_id, placed_by);

-- ===== 0055_notebook.sql =====
CREATE TABLE notebook_spaces (
  id bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  org_id bigint NOT NULL,
  work_id bigint NOT NULL,
  kind text COLLATE "C" NOT NULL CHECK (kind IN ('all', 'department', 'group')),
  name text COLLATE "C" NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 80),
  created_by bigint NOT NULL,
  created_at text COLLATE "C" NOT NULL DEFAULT to_char(statement_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS'),
  UNIQUE (org_id, id),
  UNIQUE (org_id, work_id, id),
  UNIQUE (org_id, work_id, name)
);
CREATE TRIGGER notebook_spaces_no_update BEFORE UPDATE ON notebook_spaces FOR EACH ROW EXECUTE FUNCTION lite_reject_change('notebook record immutable');
CREATE TRIGGER notebook_spaces_no_delete BEFORE DELETE ON notebook_spaces FOR EACH ROW EXECUTE FUNCTION lite_reject_change('notebook record immutable');
CREATE INDEX notebook_spaces_author_idx ON notebook_spaces (org_id, created_by);
CREATE TABLE notebook_posts (
  id bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  org_id bigint NOT NULL,
  work_id bigint NOT NULL,
  space_id bigint NOT NULL,
  template text COLLATE "C" NOT NULL CHECK (template IN ('daily', 'change', 'fitting', 'location', 'call', 'free')),
  title text COLLATE "C" NOT NULL CHECK (length(trim(title)) BETWEEN 1 AND 200),
  fields_json text COLLATE "C" NOT NULL CHECK (lite_json_valid(fields_json) AND lite_json_type(fields_json) = 'array' AND length(fields_json) <= 20000),
  body text COLLATE "C" CHECK (body IS NULL OR length(body) BETWEEN 1 AND 5000),
  attachments_json text COLLATE "C" NOT NULL DEFAULT '[]' CHECK (lite_json_valid(attachments_json) AND lite_json_type(attachments_json) = 'array' AND length(attachments_json) <= 2000),
  design text COLLATE "C" NOT NULL CHECK (design IN ('simple', 'table', 'print')),
  needs_ack bigint NOT NULL CHECK (needs_ack IN (0, 1)),
  corrects_post_id bigint,
  posted_by bigint NOT NULL,
  created_at text COLLATE "C" NOT NULL DEFAULT to_char(statement_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS'),
  UNIQUE (org_id, id),
  UNIQUE (org_id, space_id, id)
);
CREATE TRIGGER notebook_posts_no_update BEFORE UPDATE ON notebook_posts FOR EACH ROW EXECUTE FUNCTION lite_reject_change('notebook record immutable');
CREATE TRIGGER notebook_posts_no_delete BEFORE DELETE ON notebook_posts FOR EACH ROW EXECUTE FUNCTION lite_reject_change('notebook record immutable');
CREATE INDEX notebook_posts_space_idx ON notebook_posts (org_id, space_id, id);
CREATE INDEX notebook_posts_work_idx ON notebook_posts (org_id, work_id, space_id);
CREATE INDEX notebook_posts_corrects_idx ON notebook_posts (org_id, space_id, corrects_post_id);
CREATE INDEX notebook_posts_author_idx ON notebook_posts (org_id, posted_by);
CREATE TABLE notebook_receipts (
  id bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  org_id bigint NOT NULL,
  post_id bigint NOT NULL,
  user_id bigint NOT NULL,
  kind text COLLATE "C" NOT NULL CHECK (kind IN ('read', 'ack')),
  created_at text COLLATE "C" NOT NULL DEFAULT to_char(statement_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS'),
  UNIQUE (org_id, id),
  UNIQUE (org_id, post_id, user_id, kind)
);
CREATE TRIGGER notebook_receipts_no_update BEFORE UPDATE ON notebook_receipts FOR EACH ROW EXECUTE FUNCTION lite_reject_change('notebook record immutable');
CREATE TRIGGER notebook_receipts_no_delete BEFORE DELETE ON notebook_receipts FOR EACH ROW EXECUTE FUNCTION lite_reject_change('notebook record immutable');
CREATE INDEX notebook_receipts_post_idx ON notebook_receipts (org_id, post_id);
CREATE INDEX notebook_receipts_user_idx ON notebook_receipts (org_id, user_id);

-- ===== 0056_source_document_moves.sql =====
CREATE TABLE source_document_moves (
  id bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  org_id bigint NOT NULL,
  document_id bigint NOT NULL,
  from_location text COLLATE "C" NOT NULL CHECK (length(from_location) BETWEEN 1 AND 500),
  to_location text COLLATE "C" NOT NULL CHECK (length(to_location) BETWEEN 1 AND 500),
  moved_at text COLLATE "C" NOT NULL DEFAULT to_char(statement_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS'),
  moved_by bigint NOT NULL,
  reason text COLLATE "C" CHECK (reason IS NULL OR length(reason) <= 500),
  CHECK (from_location <> to_location)
);
CREATE INDEX source_document_moves_document ON source_document_moves (org_id, document_id, id);
CREATE TRIGGER source_document_moves_no_update BEFORE UPDATE ON source_document_moves FOR EACH ROW EXECUTE FUNCTION lite_reject_change('原本の場所の移動は変更できません');
CREATE TRIGGER source_document_moves_no_delete BEFORE DELETE ON source_document_moves FOR EACH ROW EXECUTE FUNCTION lite_reject_change('原本の場所の移動は削除できません');
CREATE FUNCTION source_document_moves_external_only_fn() RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  IF (EXISTS (SELECT 1 FROM source_documents WHERE org_id = NEW.org_id AND id = NEW.document_id AND storage <> 'external')) IS NOT TRUE THEN RETURN NEW; END IF;
  RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = '外の置き場の原本だけ移動できます';
  RETURN NEW;
END
$fn$;
CREATE TRIGGER source_document_moves_external_only BEFORE INSERT ON source_document_moves FOR EACH ROW EXECUTE FUNCTION source_document_moves_external_only_fn();

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
ALTER TABLE action_steps ADD FOREIGN KEY (parent_code) REFERENCES action_steps (code);
ALTER TABLE project_stages ADD FOREIGN KEY (step_code) REFERENCES action_steps (code);
ALTER TABLE project_stage_meanings ADD FOREIGN KEY (stage_code) REFERENCES project_stages (code);
ALTER TABLE project_stage_meanings ADD FOREIGN KEY (earning_type) REFERENCES earning_types (code);
ALTER TABLE projects ADD FOREIGN KEY (earning_type) REFERENCES earning_types (code);
ALTER TABLE project_stage_events ADD FOREIGN KEY (stage_code) REFERENCES project_stages (code);
ALTER TABLE project_stage_events ADD FOREIGN KEY (previous_stage_code) REFERENCES project_stages (code);
ALTER TABLE project_stage_events ADD FOREIGN KEY (org_id, project_id) REFERENCES projects (org_id, id);
ALTER TABLE project_stage_events ADD FOREIGN KEY (org_id, created_by) REFERENCES memberships (org_id, user_id);
ALTER TABLE earning_type_rate_versions ADD FOREIGN KEY (org_id) REFERENCES organizations (id);
ALTER TABLE earning_type_rate_versions ADD FOREIGN KEY (earning_type) REFERENCES earning_types (code);
ALTER TABLE earning_type_rate_versions ADD FOREIGN KEY (org_id, created_by) REFERENCES memberships (org_id, user_id);
ALTER TABLE cashflow_categories ADD FOREIGN KEY (org_id) REFERENCES organizations (id);
ALTER TABLE contract_production_versions ADD FOREIGN KEY (org_id, project_id) REFERENCES projects (org_id, id);
ALTER TABLE contract_production_versions ADD FOREIGN KEY (org_id, created_by) REFERENCES memberships (org_id, user_id);
ALTER TABLE contract_production_milestones ADD FOREIGN KEY (org_id, project_id, version_no) REFERENCES contract_production_versions (org_id, project_id, version_no);
ALTER TABLE yojitsu_periods ADD FOREIGN KEY (org_id) REFERENCES organizations (id);
ALTER TABLE yojitsu_periods ADD FOREIGN KEY (org_id, created_by) REFERENCES memberships (org_id, user_id);
ALTER TABLE yojitsu_target_versions ADD FOREIGN KEY (org_id, period_id) REFERENCES yojitsu_periods (org_id, id);
ALTER TABLE yojitsu_target_versions ADD FOREIGN KEY (org_id, owner_user_id) REFERENCES memberships (org_id, user_id);
ALTER TABLE yojitsu_target_versions ADD FOREIGN KEY (org_id, created_by) REFERENCES memberships (org_id, user_id);
ALTER TABLE yojitsu_plan_versions ADD FOREIGN KEY (org_id, period_id) REFERENCES yojitsu_periods (org_id, id);
ALTER TABLE yojitsu_plan_versions ADD FOREIGN KEY (org_id, owner_user_id) REFERENCES memberships (org_id, user_id);
ALTER TABLE yojitsu_plan_versions ADD FOREIGN KEY (org_id, created_by) REFERENCES memberships (org_id, user_id);
ALTER TABLE yojitsu_plan_amounts ADD FOREIGN KEY (earning_type) REFERENCES earning_types (code);
ALTER TABLE yojitsu_plan_amounts ADD FOREIGN KEY (org_id, plan_version_id) REFERENCES yojitsu_plan_versions (org_id, id);
ALTER TABLE plan_adoptions ADD FOREIGN KEY (org_id, period_id, plan_version_id) REFERENCES yojitsu_plan_versions (org_id, period_id, id);
ALTER TABLE plan_adoptions ADD FOREIGN KEY (org_id, created_by) REFERENCES memberships (org_id, user_id);
ALTER TABLE yojitsu_setting_versions ADD FOREIGN KEY (org_id) REFERENCES organizations (id);
ALTER TABLE yojitsu_setting_versions ADD FOREIGN KEY (variable_key) REFERENCES yojitsu_variables (code);
ALTER TABLE yojitsu_setting_versions ADD FOREIGN KEY (earning_type) REFERENCES earning_types (code);
ALTER TABLE yojitsu_setting_versions ADD FOREIGN KEY (step) REFERENCES action_steps (code);
ALTER TABLE yojitsu_setting_versions ADD FOREIGN KEY (org_id, project_id) REFERENCES projects (org_id, id);
ALTER TABLE yojitsu_setting_versions ADD FOREIGN KEY (org_id, created_by) REFERENCES memberships (org_id, user_id);
ALTER TABLE yojitsu_forecast_versions ADD FOREIGN KEY (org_id, project_id) REFERENCES projects (org_id, id);
ALTER TABLE yojitsu_forecast_versions ADD FOREIGN KEY (org_id, created_by) REFERENCES memberships (org_id, user_id);
ALTER TABLE yojitsu_forecast_lines ADD FOREIGN KEY (org_id, project_id, version_no) REFERENCES yojitsu_forecast_versions (org_id, project_id, version_no);
ALTER TABLE yojitsu_forecast_lines ADD FOREIGN KEY (org_id, category_id) REFERENCES cashflow_categories (org_id, id);
ALTER TABLE yojitsu_activity_records ADD FOREIGN KEY (earning_type) REFERENCES earning_types (code);
ALTER TABLE yojitsu_activity_records ADD FOREIGN KEY (step) REFERENCES action_steps (code);
ALTER TABLE yojitsu_activity_records ADD FOREIGN KEY (org_id, project_id) REFERENCES projects (org_id, id);
ALTER TABLE yojitsu_activity_records ADD FOREIGN KEY (org_id, project_id, work_id) REFERENCES works (org_id, project_id, id);
ALTER TABLE yojitsu_activity_records ADD FOREIGN KEY (org_id, source_sales_activity_id) REFERENCES sales_activities (org_id, id);
ALTER TABLE yojitsu_activity_records ADD FOREIGN KEY (org_id, created_by) REFERENCES memberships (org_id, user_id);
ALTER TABLE yojitsu_activity_cancellations ADD FOREIGN KEY (org_id, activity_id) REFERENCES yojitsu_activity_records (org_id, id);
ALTER TABLE yojitsu_activity_cancellations ADD FOREIGN KEY (org_id, created_by) REFERENCES memberships (org_id, user_id);
ALTER TABLE production_cost_versions ADD FOREIGN KEY (org_id, work_id) REFERENCES works (org_id, id);
ALTER TABLE production_cost_versions ADD FOREIGN KEY (org_id, work_id, work_finance_revision) REFERENCES work_finance_versions (org_id, work_id, revision);
ALTER TABLE production_cost_versions ADD FOREIGN KEY (org_id, committee_term_version_id) REFERENCES committee_term_versions (org_id, id);
ALTER TABLE production_cost_versions ADD FOREIGN KEY (org_id, counterparty_partner_id) REFERENCES partners (org_id, id);
ALTER TABLE production_cost_versions ADD FOREIGN KEY (org_id, created_by) REFERENCES memberships (org_id, user_id);
ALTER TABLE kpi_metric_versions ADD FOREIGN KEY (org_id) REFERENCES organizations (id);
ALTER TABLE kpi_metric_versions ADD FOREIGN KEY (org_id, created_by) REFERENCES memberships (org_id, user_id);
ALTER TABLE kpi_metric_steps ADD FOREIGN KEY (earning_type) REFERENCES earning_types (code);
ALTER TABLE kpi_metric_steps ADD FOREIGN KEY (step) REFERENCES action_steps (code);
ALTER TABLE kpi_metric_steps ADD FOREIGN KEY (org_id, metric_version_id) REFERENCES kpi_metric_versions (org_id, id);
ALTER TABLE yojitsu_choice_versions ADD FOREIGN KEY (org_id) REFERENCES organizations (id);
ALTER TABLE yojitsu_choice_versions ADD FOREIGN KEY (org_id, created_by) REFERENCES memberships (org_id, user_id);
ALTER TABLE investment_approval_versions ADD FOREIGN KEY (org_id, project_id) REFERENCES projects (org_id, id);
ALTER TABLE investment_approval_versions ADD FOREIGN KEY (org_id, created_by) REFERENCES memberships (org_id, user_id);
ALTER TABLE sales_source_file_terms ADD FOREIGN KEY (org_id, file_id) REFERENCES sales_source_files (org_id, id);
ALTER TABLE sales_source_file_terms ADD FOREIGN KEY (org_id, partner_id) REFERENCES partners (org_id, id);
ALTER TABLE sales_source_file_terms ADD FOREIGN KEY (org_id, created_by) REFERENCES memberships (org_id, user_id);
ALTER TABLE report_voids ADD FOREIGN KEY (org_id, report_id) REFERENCES report_imports (org_id, id);
ALTER TABLE report_voids ADD FOREIGN KEY (org_id, created_by) REFERENCES memberships (org_id, user_id);
ALTER TABLE report_check_versions ADD FOREIGN KEY (org_id, partner_id) REFERENCES partners (org_id, id);
ALTER TABLE report_check_versions ADD FOREIGN KEY (org_id, mapping_version_id) REFERENCES report_mapping_versions (org_id, id);
ALTER TABLE report_check_versions ADD FOREIGN KEY (org_id, created_by) REFERENCES memberships (org_id, user_id);
ALTER TABLE report_check_cases ADD FOREIGN KEY (org_id, check_version_id) REFERENCES report_check_versions (org_id, id);
ALTER TABLE report_check_cases ADD FOREIGN KEY (org_id, created_by) REFERENCES memberships (org_id, user_id);
ALTER TABLE source_check_runs ADD FOREIGN KEY (org_id, file_id) REFERENCES sales_source_files (org_id, id);
ALTER TABLE source_check_runs ADD FOREIGN KEY (org_id, check_version_id) REFERENCES report_check_versions (org_id, id);
ALTER TABLE source_sampling_reviews ADD FOREIGN KEY (org_id, check_run_id) REFERENCES source_check_runs (org_id, id);
ALTER TABLE source_sampling_reviews ADD FOREIGN KEY (org_id, created_by) REFERENCES memberships (org_id, user_id);
ALTER TABLE budget_versions ADD FOREIGN KEY (org_id, project_id) REFERENCES projects (org_id, id);
ALTER TABLE budget_versions ADD FOREIGN KEY (org_id, project_id, previous_version_id) REFERENCES budget_versions (org_id, project_id, id);
ALTER TABLE budget_versions ADD FOREIGN KEY (org_id, created_by) REFERENCES memberships (org_id, user_id);
ALTER TABLE budget_version_lines ADD FOREIGN KEY (org_id, project_id, version_id) REFERENCES budget_versions (org_id, project_id, id);
ALTER TABLE budget_version_lines ADD FOREIGN KEY (org_id, project_id, work_id) REFERENCES works (org_id, project_id, id);
ALTER TABLE budget_check_runs ADD FOREIGN KEY (org_id, project_id, version_id) REFERENCES budget_versions (org_id, project_id, id);
ALTER TABLE budget_check_runs ADD FOREIGN KEY (org_id, created_by) REFERENCES memberships (org_id, user_id);
ALTER TABLE budget_fixes ADD FOREIGN KEY (org_id, project_id, version_id) REFERENCES budget_versions (org_id, project_id, id);
ALTER TABLE budget_fixes ADD FOREIGN KEY (org_id, created_by) REFERENCES memberships (org_id, user_id);
ALTER TABLE source_documents ADD FOREIGN KEY (org_id, received_by) REFERENCES memberships (org_id, user_id);
ALTER TABLE acq_mg_contracts ADD FOREIGN KEY (org_id, partner_id) REFERENCES partners (org_id, id);
ALTER TABLE acq_mg_contracts ADD FOREIGN KEY (org_id, intake_case_id) REFERENCES rights_intake_cases (org_id, id);
ALTER TABLE acq_mg_contracts ADD FOREIGN KEY (org_id, legacy_settlement_contract_id) REFERENCES settlement_contracts (org_id, id);
ALTER TABLE acq_mg_contracts ADD FOREIGN KEY (org_id, legacy_outgoing_contract_id) REFERENCES mg_outgoing_contracts (org_id, id);
ALTER TABLE acq_mg_contracts ADD FOREIGN KEY (org_id, created_by) REFERENCES memberships (org_id, user_id);
ALTER TABLE acq_mg_term_versions ADD FOREIGN KEY (org_id, contract_id) REFERENCES acq_mg_contracts (org_id, id);
ALTER TABLE acq_mg_term_versions ADD FOREIGN KEY (org_id, created_by) REFERENCES memberships (org_id, user_id);
ALTER TABLE acq_mg_term_works ADD FOREIGN KEY (org_id, term_version_id) REFERENCES acq_mg_term_versions (org_id, id);
ALTER TABLE acq_mg_term_works ADD FOREIGN KEY (org_id, work_id) REFERENCES works (org_id, id);
ALTER TABLE acq_mg_term_deductions ADD FOREIGN KEY (org_id, term_version_id) REFERENCES acq_mg_term_versions (org_id, id);
ALTER TABLE acq_mg_term_phases ADD FOREIGN KEY (org_id, term_version_id) REFERENCES acq_mg_term_versions (org_id, id);
ALTER TABLE acq_mg_term_media_allocations ADD FOREIGN KEY (org_id, term_version_id) REFERENCES acq_mg_term_versions (org_id, id);
ALTER TABLE acq_mg_payment_schedule ADD FOREIGN KEY (org_id, term_version_id) REFERENCES acq_mg_term_versions (org_id, id);
ALTER TABLE acq_mg_report_links ADD FOREIGN KEY (org_id, report_id) REFERENCES report_imports (org_id, id);
ALTER TABLE acq_mg_report_links ADD FOREIGN KEY (org_id, work_id) REFERENCES works (org_id, id);
ALTER TABLE acq_mg_report_links ADD FOREIGN KEY (org_id, term_version_id) REFERENCES acq_mg_term_versions (org_id, id);
ALTER TABLE acq_mg_report_links ADD FOREIGN KEY (org_id, replaces_link_id) REFERENCES acq_mg_report_links (org_id, id);
ALTER TABLE acq_mg_report_links ADD FOREIGN KEY (org_id, created_by) REFERENCES memberships (org_id, user_id);
ALTER TABLE acq_mg_statements ADD FOREIGN KEY (org_id, term_version_id) REFERENCES acq_mg_term_versions (org_id, id);
ALTER TABLE acq_mg_statements ADD FOREIGN KEY (org_id, voids_statement_id) REFERENCES acq_mg_statements (org_id, id);
ALTER TABLE acq_mg_statements ADD FOREIGN KEY (org_id, created_by) REFERENCES memberships (org_id, user_id);
ALTER TABLE acq_mg_documents ADD FOREIGN KEY (org_id, contract_id) REFERENCES acq_mg_contracts (org_id, id);
ALTER TABLE acq_mg_documents ADD FOREIGN KEY (org_id, term_version_id) REFERENCES acq_mg_term_versions (org_id, id);
ALTER TABLE acq_mg_documents ADD FOREIGN KEY (org_id, source_document_id) REFERENCES source_documents (org_id, id);
ALTER TABLE acq_mg_documents ADD FOREIGN KEY (org_id, created_by) REFERENCES memberships (org_id, user_id);
ALTER TABLE acq_mg_payments ADD FOREIGN KEY (org_id, contract_id) REFERENCES acq_mg_contracts (org_id, id);
ALTER TABLE acq_mg_payments ADD FOREIGN KEY (org_id, term_version_id) REFERENCES acq_mg_term_versions (org_id, id);
ALTER TABLE acq_mg_payments ADD FOREIGN KEY (org_id, statement_id) REFERENCES acq_mg_statements (org_id, id);
ALTER TABLE acq_mg_payments ADD FOREIGN KEY (org_id, partner_id) REFERENCES partners (org_id, id);
ALTER TABLE acq_mg_payments ADD FOREIGN KEY (org_id, reverses_payment_id) REFERENCES acq_mg_payments (org_id, id);
ALTER TABLE acq_mg_payments ADD FOREIGN KEY (org_id, created_by) REFERENCES memberships (org_id, user_id);
ALTER TABLE budget_templates ADD FOREIGN KEY (org_id, created_by) REFERENCES memberships (org_id, user_id);
ALTER TABLE budget_template_versions ADD FOREIGN KEY (org_id, template_id) REFERENCES budget_templates (org_id, id);
ALTER TABLE budget_template_versions ADD FOREIGN KEY (org_id, source_project_id, source_budget_version_id) REFERENCES budget_versions (org_id, project_id, id);
ALTER TABLE budget_template_versions ADD FOREIGN KEY (org_id, created_by) REFERENCES memberships (org_id, user_id);
ALTER TABLE budget_template_items ADD FOREIGN KEY (org_id, template_version_id) REFERENCES budget_template_versions (org_id, id);
ALTER TABLE budget_version_templates ADD FOREIGN KEY (org_id, project_id, version_id) REFERENCES budget_versions (org_id, project_id, id);
ALTER TABLE budget_version_templates ADD FOREIGN KEY (org_id, template_version_id) REFERENCES budget_template_versions (org_id, id);
ALTER TABLE budget_line_items ADD FOREIGN KEY (org_id, project_id, version_id) REFERENCES budget_versions (org_id, project_id, id);
ALTER TABLE budget_line_items ADD FOREIGN KEY (org_id, version_id, category_code, line_no) REFERENCES budget_version_lines (org_id, version_id, category_code, line_no);
ALTER TABLE expense_file_placements ADD FOREIGN KEY (org_id, file_id) REFERENCES expense_source_files (org_id, id);
ALTER TABLE expense_file_placements ADD FOREIGN KEY (org_id, created_by) REFERENCES memberships (org_id, user_id);
ALTER TABLE expense_file_placement_voids ADD FOREIGN KEY (org_id, placement_id) REFERENCES expense_file_placements (org_id, id);
ALTER TABLE expense_file_placement_voids ADD FOREIGN KEY (org_id, created_by) REFERENCES memberships (org_id, user_id);
ALTER TABLE expense_month_closures ADD FOREIGN KEY (org_id, created_by) REFERENCES memberships (org_id, user_id);
ALTER TABLE committee_term_templates ADD FOREIGN KEY (org_id, previous_id) REFERENCES committee_term_templates (org_id, id);
ALTER TABLE committee_term_templates ADD FOREIGN KEY (org_id, created_by) REFERENCES memberships (org_id, user_id);
ALTER TABLE committee_term_version_templates ADD FOREIGN KEY (org_id, term_version_id) REFERENCES committee_term_versions (org_id, id);
ALTER TABLE committee_term_version_templates ADD FOREIGN KEY (org_id, template_id) REFERENCES committee_term_templates (org_id, id);
ALTER TABLE committee_term_version_templates ADD FOREIGN KEY (org_id, created_by) REFERENCES memberships (org_id, user_id);
ALTER TABLE committee_term_businesses ADD FOREIGN KEY (org_id, term_version_id) REFERENCES committee_term_versions (org_id, id);
ALTER TABLE committee_term_businesses ADD FOREIGN KEY (org_id, operator_partner_id) REFERENCES partners (org_id, id);
ALTER TABLE committee_term_businesses ADD FOREIGN KEY (org_id, created_by) REFERENCES memberships (org_id, user_id);
ALTER TABLE committee_term_business_steps ADD FOREIGN KEY (org_id, term_version_id, business_code) REFERENCES committee_term_businesses (org_id, term_version_id, business_code);
ALTER TABLE committee_term_business_steps ADD FOREIGN KEY (org_id, created_by) REFERENCES memberships (org_id, user_id);
ALTER TABLE committee_term_committee_steps ADD FOREIGN KEY (org_id, term_version_id) REFERENCES committee_term_versions (org_id, id);
ALTER TABLE committee_term_committee_steps ADD FOREIGN KEY (org_id, recipient_partner_id) REFERENCES partners (org_id, id);
ALTER TABLE committee_term_committee_steps ADD FOREIGN KEY (org_id, created_by) REFERENCES memberships (org_id, user_id);
ALTER TABLE committee_term_budget_lines ADD FOREIGN KEY (org_id, term_version_id) REFERENCES committee_term_versions (org_id, id);
ALTER TABLE committee_term_budget_lines ADD FOREIGN KEY (org_id, created_by) REFERENCES memberships (org_id, user_id);
ALTER TABLE committee_schedule_versions ADD FOREIGN KEY (org_id, contract_id) REFERENCES committee_contracts (org_id, id);
ALTER TABLE committee_schedule_versions ADD FOREIGN KEY (org_id, created_by) REFERENCES memberships (org_id, user_id);
ALTER TABLE committee_schedule_version_phases ADD FOREIGN KEY (org_id, schedule_version_id) REFERENCES committee_schedule_versions (org_id, id);
ALTER TABLE committee_schedule_version_phases ADD FOREIGN KEY (org_id, created_by) REFERENCES memberships (org_id, user_id);
ALTER TABLE committee_round_overrides ADD FOREIGN KEY (org_id, contract_id) REFERENCES committee_contracts (org_id, id);
ALTER TABLE committee_round_overrides ADD FOREIGN KEY (org_id, created_by) REFERENCES memberships (org_id, user_id);
ALTER TABLE committee_ledger_entries ADD FOREIGN KEY (org_id, contract_id) REFERENCES committee_contracts (org_id, id);
ALTER TABLE committee_ledger_entries ADD FOREIGN KEY (org_id, counterparty_partner_id) REFERENCES partners (org_id, id);
ALTER TABLE committee_ledger_entries ADD FOREIGN KEY (org_id, reverses_id) REFERENCES committee_ledger_entries (org_id, id);
ALTER TABLE committee_ledger_entries ADD FOREIGN KEY (org_id, created_by) REFERENCES memberships (org_id, user_id);
ALTER TABLE bank_accounts ADD FOREIGN KEY (org_id, gl_account_id) REFERENCES gl_accounts (org_id, id);
ALTER TABLE bank_accounts ADD FOREIGN KEY (org_id, created_by) REFERENCES memberships (org_id, user_id);
ALTER TABLE bank_statement_imports ADD FOREIGN KEY (org_id, bank_account_id) REFERENCES bank_accounts (org_id, id);
ALTER TABLE bank_statement_imports ADD FOREIGN KEY (org_id, created_by) REFERENCES memberships (org_id, user_id);
ALTER TABLE bank_statement_lines ADD FOREIGN KEY (org_id, bank_account_id, import_id) REFERENCES bank_statement_imports (org_id, bank_account_id, id);
ALTER TABLE journal_entries ADD FOREIGN KEY (org_id, bank_statement_line_id) REFERENCES bank_statement_lines (org_id, id);
ALTER TABLE journal_entries ADD FOREIGN KEY (org_id, reverses_entry_id) REFERENCES journal_entries (org_id, id);
ALTER TABLE journal_entries ADD FOREIGN KEY (org_id, created_by) REFERENCES memberships (org_id, user_id);
ALTER TABLE journal_lines ADD FOREIGN KEY (org_id, entry_id) REFERENCES journal_entries (org_id, id);
ALTER TABLE journal_lines ADD FOREIGN KEY (org_id, account_id) REFERENCES gl_accounts (org_id, id);
ALTER TABLE journal_lines ADD FOREIGN KEY (org_id, bank_account_id) REFERENCES bank_accounts (org_id, id);
ALTER TABLE mfg_products ADD FOREIGN KEY (org_id, project_id, work_id) REFERENCES works (org_id, project_id, id);
ALTER TABLE mfg_products ADD FOREIGN KEY (org_id, created_by) REFERENCES memberships (org_id, user_id);
ALTER TABLE mfg_product_versions ADD FOREIGN KEY (org_id, product_id) REFERENCES mfg_products (org_id, id);
ALTER TABLE mfg_product_versions ADD FOREIGN KEY (org_id, created_by) REFERENCES memberships (org_id, user_id);
ALTER TABLE mfg_step_events ADD FOREIGN KEY (org_id, product_id) REFERENCES mfg_products (org_id, id);
ALTER TABLE mfg_step_events ADD FOREIGN KEY (org_id, voids_event_id) REFERENCES mfg_step_events (org_id, id);
ALTER TABLE mfg_step_events ADD FOREIGN KEY (org_id, created_by) REFERENCES memberships (org_id, user_id);
ALTER TABLE mfg_purchase_orders ADD FOREIGN KEY (org_id, product_id) REFERENCES mfg_products (org_id, id);
ALTER TABLE mfg_purchase_orders ADD FOREIGN KEY (org_id, partner_id) REFERENCES partners (org_id, id);
ALTER TABLE mfg_purchase_orders ADD FOREIGN KEY (org_id, created_by) REFERENCES memberships (org_id, user_id);
ALTER TABLE mfg_purchase_order_lines ADD FOREIGN KEY (org_id, po_id) REFERENCES mfg_purchase_orders (org_id, id);
ALTER TABLE mfg_po_events ADD FOREIGN KEY (org_id, po_id) REFERENCES mfg_purchase_orders (org_id, id);
ALTER TABLE mfg_po_events ADD FOREIGN KEY (org_id, created_by) REFERENCES memberships (org_id, user_id);
ALTER TABLE mfg_receipts ADD FOREIGN KEY (org_id, po_line_id) REFERENCES mfg_purchase_order_lines (org_id, id);
ALTER TABLE mfg_receipts ADD FOREIGN KEY (org_id, created_by) REFERENCES memberships (org_id, user_id);
ALTER TABLE mfg_po_expenses ADD FOREIGN KEY (org_id, po_line_id) REFERENCES mfg_purchase_order_lines (org_id, id);
ALTER TABLE mfg_po_expenses ADD FOREIGN KEY (org_id, expense_id) REFERENCES expenses (org_id, id);
ALTER TABLE mfg_po_expenses ADD FOREIGN KEY (org_id, created_by) REFERENCES memberships (org_id, user_id);
ALTER TABLE produce_tasks ADD FOREIGN KEY (org_id, project_id) REFERENCES projects (org_id, id);
ALTER TABLE produce_tasks ADD FOREIGN KEY (org_id, project_id, work_id) REFERENCES works (org_id, project_id, id);
ALTER TABLE produce_tasks ADD FOREIGN KEY (org_id, created_by) REFERENCES memberships (org_id, user_id);
ALTER TABLE produce_task_events ADD FOREIGN KEY (org_id, project_id) REFERENCES projects (org_id, id);
ALTER TABLE produce_task_events ADD FOREIGN KEY (org_id, created_by) REFERENCES memberships (org_id, user_id);
ALTER TABLE produce_task_checks ADD FOREIGN KEY (org_id, project_id) REFERENCES projects (org_id, id);
ALTER TABLE produce_task_checks ADD FOREIGN KEY (org_id, created_by) REFERENCES memberships (org_id, user_id);
ALTER TABLE produce_task_posts ADD FOREIGN KEY (org_id, project_id) REFERENCES projects (org_id, id);
ALTER TABLE produce_task_posts ADD FOREIGN KEY (org_id, created_by) REFERENCES memberships (org_id, user_id);
ALTER TABLE produce_task_links ADD FOREIGN KEY (org_id, project_id) REFERENCES projects (org_id, id);
ALTER TABLE produce_task_links ADD FOREIGN KEY (org_id, created_by) REFERENCES memberships (org_id, user_id);
ALTER TABLE produce_task_templates ADD FOREIGN KEY (org_id, created_by) REFERENCES memberships (org_id, user_id);
ALTER TABLE produce_task_template_items ADD FOREIGN KEY (org_id, template_id) REFERENCES produce_task_templates (org_id, id);
ALTER TABLE post_cuts ADD FOREIGN KEY (org_id, project_id, work_id) REFERENCES works (org_id, project_id, id);
ALTER TABLE post_cuts ADD FOREIGN KEY (org_id, created_by) REFERENCES memberships (org_id, user_id);
ALTER TABLE post_notes ADD FOREIGN KEY (org_id, work_id, cut_id) REFERENCES post_cuts (org_id, work_id, id);
ALTER TABLE post_notes ADD FOREIGN KEY (org_id, created_by) REFERENCES memberships (org_id, user_id);
ALTER TABLE post_note_actions ADD FOREIGN KEY (org_id, work_id, note_id) REFERENCES post_notes (org_id, work_id, id);
ALTER TABLE post_note_actions ADD FOREIGN KEY (org_id, work_id, fixed_cut_id) REFERENCES post_cuts (org_id, work_id, id);
ALTER TABLE post_note_actions ADD FOREIGN KEY (org_id, created_by) REFERENCES memberships (org_id, user_id);
ALTER TABLE post_tasks ADD FOREIGN KEY (org_id, project_id, work_id) REFERENCES works (org_id, project_id, id);
ALTER TABLE post_tasks ADD FOREIGN KEY (org_id, created_by) REFERENCES memberships (org_id, user_id);
ALTER TABLE post_task_events ADD FOREIGN KEY (org_id, work_id, task_id) REFERENCES post_tasks (org_id, work_id, id);
ALTER TABLE post_task_events ADD FOREIGN KEY (org_id, created_by) REFERENCES memberships (org_id, user_id);
ALTER TABLE post_deliverable_items ADD FOREIGN KEY (org_id, project_id, work_id) REFERENCES works (org_id, project_id, id);
ALTER TABLE post_deliverable_items ADD FOREIGN KEY (org_id, committee_contract_id, committee_term_version_id) REFERENCES committee_term_versions (org_id, contract_id, id);
ALTER TABLE post_deliverable_items ADD FOREIGN KEY (org_id, sales_deliverable_id) REFERENCES sales_deliverables (org_id, id);
ALTER TABLE post_deliverable_items ADD FOREIGN KEY (org_id, created_by) REFERENCES memberships (org_id, user_id);
ALTER TABLE post_deliverable_events ADD FOREIGN KEY (org_id, work_id, item_id) REFERENCES post_deliverable_items (org_id, work_id, id);
ALTER TABLE post_deliverable_events ADD FOREIGN KEY (org_id, created_by) REFERENCES memberships (org_id, user_id);
ALTER TABLE sales_proposals ADD FOREIGN KEY (org_id, opportunity_id) REFERENCES sales_opportunities (org_id, id);
ALTER TABLE sales_proposals ADD FOREIGN KEY (org_id, material_snapshot_id) REFERENCES sales_material_snapshots (org_id, id);
ALTER TABLE sales_proposals ADD FOREIGN KEY (org_id, created_by) REFERENCES memberships (org_id, user_id);
ALTER TABLE sales_proposal_windows ADD FOREIGN KEY (org_id, proposal_id) REFERENCES sales_proposals (org_id, id);
ALTER TABLE sales_proposal_windows ADD FOREIGN KEY (org_id, window_id) REFERENCES work_release_windows (org_id, id);
ALTER TABLE sales_proposal_reviews ADD FOREIGN KEY (org_id, proposal_id) REFERENCES sales_proposals (org_id, id);
ALTER TABLE sales_proposal_reviews ADD FOREIGN KEY (org_id, agreement_id) REFERENCES sales_agreements (org_id, id);
ALTER TABLE sales_proposal_reviews ADD FOREIGN KEY (org_id, created_by) REFERENCES memberships (org_id, user_id);
ALTER TABLE sales_proposal_review_factors ADD FOREIGN KEY (org_id, review_id) REFERENCES sales_proposal_reviews (org_id, id);
ALTER TABLE sales_activity_notes ADD FOREIGN KEY (org_id, activity_id) REFERENCES sales_activities (org_id, id);
ALTER TABLE sales_activity_notes ADD FOREIGN KEY (org_id, created_by) REFERENCES memberships (org_id, user_id);
ALTER TABLE planning_documents ADD FOREIGN KEY (org_id, project_id) REFERENCES projects (org_id, id);
ALTER TABLE planning_documents ADD FOREIGN KEY (org_id, document_id) REFERENCES source_documents (org_id, id);
ALTER TABLE planning_documents ADD FOREIGN KEY (org_id, created_by) REFERENCES memberships (org_id, user_id);
ALTER TABLE planning_profile_versions ADD FOREIGN KEY (org_id, project_id) REFERENCES projects (org_id, id);
ALTER TABLE planning_profile_versions ADD FOREIGN KEY (org_id, created_by) REFERENCES memberships (org_id, user_id);
ALTER TABLE planning_profile_people ADD FOREIGN KEY (org_id, version_id) REFERENCES planning_profile_versions (org_id, id);
ALTER TABLE planning_trial_versions ADD FOREIGN KEY (org_id, project_id) REFERENCES projects (org_id, id);
ALTER TABLE planning_trial_versions ADD FOREIGN KEY (org_id, document_id) REFERENCES source_documents (org_id, id);
ALTER TABLE planning_trial_versions ADD FOREIGN KEY (org_id, created_by) REFERENCES memberships (org_id, user_id);
ALTER TABLE planning_trial_rates ADD FOREIGN KEY (org_id, version_id) REFERENCES planning_trial_versions (org_id, id);
ALTER TABLE planning_trial_lines ADD FOREIGN KEY (org_id, version_id) REFERENCES planning_trial_versions (org_id, id);
ALTER TABLE planning_trial_investments ADD FOREIGN KEY (org_id, version_id) REFERENCES planning_trial_versions (org_id, id);
ALTER TABLE project_owner_versions ADD FOREIGN KEY (org_id, project_id) REFERENCES projects (org_id, id);
ALTER TABLE project_owner_versions ADD FOREIGN KEY (org_id, user_id) REFERENCES memberships (org_id, user_id);
ALTER TABLE project_owner_versions ADD FOREIGN KEY (org_id, created_by) REFERENCES memberships (org_id, user_id);
ALTER TABLE planning_materials ADD FOREIGN KEY (org_id, project_id) REFERENCES projects (org_id, id);
ALTER TABLE planning_materials ADD FOREIGN KEY (org_id, document_id) REFERENCES source_documents (org_id, id);
ALTER TABLE planning_materials ADD FOREIGN KEY (org_id, created_by) REFERENCES memberships (org_id, user_id);
ALTER TABLE planning_facts ADD FOREIGN KEY (org_id, project_id) REFERENCES projects (org_id, id);
ALTER TABLE planning_facts ADD FOREIGN KEY (org_id, project_id, material_id) REFERENCES planning_materials (org_id, project_id, id);
ALTER TABLE planning_facts ADD FOREIGN KEY (org_id, project_id, previous_id) REFERENCES planning_facts (org_id, project_id, id);
ALTER TABLE planning_facts ADD FOREIGN KEY (org_id, created_by) REFERENCES memberships (org_id, user_id);
ALTER TABLE shooting_scene_results ADD FOREIGN KEY (org_id, project_id, work_id) REFERENCES works (org_id, project_id, id);
ALTER TABLE shooting_scene_results ADD FOREIGN KEY (org_id, work_id, shooting_day_id) REFERENCES shooting_days (org_id, work_id, id);
ALTER TABLE shooting_scene_results ADD FOREIGN KEY (org_id, work_id, postponed_to_day_id) REFERENCES shooting_days (org_id, work_id, id);
ALTER TABLE shooting_scene_results ADD FOREIGN KEY (org_id, work_id, scene_id) REFERENCES scenes (org_id, work_id, id);
ALTER TABLE shooting_scene_results ADD FOREIGN KEY (org_id, created_by) REFERENCES memberships (org_id, user_id);
ALTER TABLE shooting_day_records ADD FOREIGN KEY (org_id, project_id, work_id) REFERENCES works (org_id, project_id, id);
ALTER TABLE shooting_day_records ADD FOREIGN KEY (org_id, work_id, shooting_day_id) REFERENCES shooting_days (org_id, work_id, id);
ALTER TABLE shooting_day_records ADD FOREIGN KEY (org_id, source_document_id) REFERENCES source_documents (org_id, id);
ALTER TABLE shooting_day_records ADD FOREIGN KEY (org_id, created_by) REFERENCES memberships (org_id, user_id);
ALTER TABLE shooting_day_report_items ADD FOREIGN KEY (org_id, project_id, work_id) REFERENCES works (org_id, project_id, id);
ALTER TABLE shooting_day_report_items ADD FOREIGN KEY (org_id, work_id, shooting_day_id) REFERENCES shooting_days (org_id, work_id, id);
ALTER TABLE shooting_day_report_items ADD FOREIGN KEY (org_id, work_id, scene_id) REFERENCES scenes (org_id, work_id, id);
ALTER TABLE shooting_day_report_items ADD FOREIGN KEY (org_id, record_id) REFERENCES shooting_day_records (org_id, id);
ALTER TABLE shooting_day_report_items ADD FOREIGN KEY (org_id, replaces_id) REFERENCES shooting_day_report_items (org_id, id);
ALTER TABLE shooting_day_report_items ADD FOREIGN KEY (org_id, created_by) REFERENCES memberships (org_id, user_id);
ALTER TABLE chotatsu_cases ADD FOREIGN KEY (org_id, created_by) REFERENCES memberships (org_id, user_id);
ALTER TABLE chotatsu_case_versions ADD FOREIGN KEY (org_id, case_id) REFERENCES chotatsu_cases (org_id, id);
ALTER TABLE chotatsu_case_versions ADD FOREIGN KEY (org_id, holder_partner_id) REFERENCES partners (org_id, id);
ALTER TABLE chotatsu_case_versions ADD FOREIGN KEY (org_id, distributor_partner_id) REFERENCES partners (org_id, id);
ALTER TABLE chotatsu_case_versions ADD FOREIGN KEY (org_id, work_id) REFERENCES works (org_id, id);
ALTER TABLE chotatsu_case_versions ADD FOREIGN KEY (org_id, sales_activity_id) REFERENCES sales_activities (org_id, id);
ALTER TABLE chotatsu_case_versions ADD FOREIGN KEY (org_id, created_by) REFERENCES memberships (org_id, user_id);
ALTER TABLE chotatsu_stage_events ADD FOREIGN KEY (org_id, case_id) REFERENCES chotatsu_cases (org_id, id);
ALTER TABLE chotatsu_stage_events ADD FOREIGN KEY (org_id, created_by) REFERENCES memberships (org_id, user_id);
ALTER TABLE chotatsu_estimates ADD FOREIGN KEY (org_id, case_id) REFERENCES chotatsu_cases (org_id, id);
ALTER TABLE chotatsu_estimates ADD FOREIGN KEY (org_id, created_by) REFERENCES memberships (org_id, user_id);
ALTER TABLE chotatsu_estimate_lines ADD FOREIGN KEY (org_id, case_id, estimate_id) REFERENCES chotatsu_estimates (org_id, case_id, id);
ALTER TABLE chotatsu_estimate_lines ADD FOREIGN KEY (org_id, source_document_id) REFERENCES source_documents (org_id, id);
ALTER TABLE chotatsu_agreements ADD FOREIGN KEY (org_id, case_id, estimate_id) REFERENCES chotatsu_estimates (org_id, case_id, id);
ALTER TABLE chotatsu_agreements ADD FOREIGN KEY (org_id, source_document_id) REFERENCES source_documents (org_id, id);
ALTER TABLE chotatsu_agreements ADD FOREIGN KEY (org_id, created_by) REFERENCES memberships (org_id, user_id);
ALTER TABLE chotatsu_ringi ADD FOREIGN KEY (org_id, case_id, estimate_id) REFERENCES chotatsu_estimates (org_id, case_id, id);
ALTER TABLE chotatsu_ringi ADD FOREIGN KEY (org_id, source_document_id) REFERENCES source_documents (org_id, id);
ALTER TABLE chotatsu_ringi ADD FOREIGN KEY (org_id, created_by) REFERENCES memberships (org_id, user_id);
ALTER TABLE chotatsu_contracts ADD FOREIGN KEY (org_id, case_id) REFERENCES chotatsu_cases (org_id, id);
ALTER TABLE chotatsu_contracts ADD FOREIGN KEY (org_id, intake_case_id, work_id) REFERENCES rights_intake_cases (org_id, id, work_id);
ALTER TABLE chotatsu_contracts ADD FOREIGN KEY (org_id, settlement_contract_id, work_id) REFERENCES settlement_contracts (org_id, id, work_id);
ALTER TABLE chotatsu_contracts ADD FOREIGN KEY (org_id, signed_document_id) REFERENCES source_documents (org_id, id);
ALTER TABLE chotatsu_contracts ADD FOREIGN KEY (org_id, created_by) REFERENCES memberships (org_id, user_id);
ALTER TABLE chotatsu_materials ADD FOREIGN KEY (org_id, case_id) REFERENCES chotatsu_cases (org_id, id);
ALTER TABLE chotatsu_materials ADD FOREIGN KEY (org_id, source_document_id) REFERENCES source_documents (org_id, id);
ALTER TABLE chotatsu_materials ADD FOREIGN KEY (org_id, created_by) REFERENCES memberships (org_id, user_id);
ALTER TABLE chotatsu_handoffs ADD FOREIGN KEY (org_id, case_id) REFERENCES chotatsu_cases (org_id, id);
ALTER TABLE chotatsu_handoffs ADD FOREIGN KEY (org_id, intake_case_id, work_id) REFERENCES rights_intake_cases (org_id, id, work_id);
ALTER TABLE chotatsu_handoffs ADD FOREIGN KEY (org_id, case_id, estimate_id) REFERENCES chotatsu_estimates (org_id, case_id, id);
ALTER TABLE chotatsu_handoffs ADD FOREIGN KEY (org_id, created_by) REFERENCES memberships (org_id, user_id);
ALTER TABLE chotatsu_handoff_events ADD FOREIGN KEY (org_id, handoff_id) REFERENCES chotatsu_handoffs (org_id, id);
ALTER TABLE chotatsu_handoff_events ADD FOREIGN KEY (org_id, created_by) REFERENCES memberships (org_id, user_id);
ALTER TABLE chotatsu_documents ADD FOREIGN KEY (org_id, case_id) REFERENCES chotatsu_cases (org_id, id);
ALTER TABLE chotatsu_documents ADD FOREIGN KEY (org_id, source_document_id) REFERENCES source_documents (org_id, id);
ALTER TABLE chotatsu_documents ADD FOREIGN KEY (org_id, created_by) REFERENCES memberships (org_id, user_id);
ALTER TABLE chotatsu_case_expenses ADD FOREIGN KEY (org_id, case_id) REFERENCES chotatsu_cases (org_id, id);
ALTER TABLE chotatsu_case_expenses ADD FOREIGN KEY (org_id, expense_id) REFERENCES expenses (org_id, id);
ALTER TABLE chotatsu_case_expenses ADD FOREIGN KEY (org_id, estimate_line_id) REFERENCES chotatsu_estimate_lines (org_id, id);
ALTER TABLE chotatsu_case_expenses ADD FOREIGN KEY (org_id, created_by) REFERENCES memberships (org_id, user_id);
ALTER TABLE production_arrangement_versions ADD FOREIGN KEY (org_id, work_id) REFERENCES works (org_id, id);
ALTER TABLE production_arrangement_versions ADD FOREIGN KEY (org_id, partner_id) REFERENCES partners (org_id, id);
ALTER TABLE production_arrangement_versions ADD FOREIGN KEY (org_id, created_by) REFERENCES memberships (org_id, user_id);
ALTER TABLE scene_art_item_versions ADD FOREIGN KEY (org_id, work_id) REFERENCES works (org_id, id);
ALTER TABLE scene_art_item_versions ADD FOREIGN KEY (org_id, work_id, scene_id) REFERENCES scenes (org_id, work_id, id);
ALTER TABLE scene_art_item_versions ADD FOREIGN KEY (org_id, created_by) REFERENCES memberships (org_id, user_id);
ALTER TABLE scene_shoot_plan_versions ADD FOREIGN KEY (org_id, work_id) REFERENCES works (org_id, id);
ALTER TABLE scene_shoot_plan_versions ADD FOREIGN KEY (org_id, work_id, scene_id) REFERENCES scenes (org_id, work_id, id);
ALTER TABLE scene_shoot_plan_versions ADD FOREIGN KEY (org_id, created_by) REFERENCES memberships (org_id, user_id);
ALTER TABLE preprod_document_placements ADD FOREIGN KEY (org_id, work_id) REFERENCES works (org_id, id);
ALTER TABLE preprod_document_placements ADD FOREIGN KEY (org_id, document_id) REFERENCES source_documents (org_id, id);
ALTER TABLE preprod_document_placements ADD FOREIGN KEY (org_id, work_id, shooting_day_id) REFERENCES shooting_days (org_id, work_id, id);
ALTER TABLE preprod_document_placements ADD FOREIGN KEY (org_id, work_id, scene_id) REFERENCES scenes (org_id, work_id, id);
ALTER TABLE preprod_document_placements ADD FOREIGN KEY (org_id, placed_by) REFERENCES memberships (org_id, user_id);
ALTER TABLE notebook_spaces ADD FOREIGN KEY (org_id, work_id) REFERENCES works (org_id, id);
ALTER TABLE notebook_spaces ADD FOREIGN KEY (org_id, created_by) REFERENCES memberships (org_id, user_id);
ALTER TABLE notebook_posts ADD FOREIGN KEY (org_id, work_id, space_id) REFERENCES notebook_spaces (org_id, work_id, id);
ALTER TABLE notebook_posts ADD FOREIGN KEY (org_id, space_id, corrects_post_id) REFERENCES notebook_posts (org_id, space_id, id);
ALTER TABLE notebook_posts ADD FOREIGN KEY (org_id, posted_by) REFERENCES memberships (org_id, user_id);
ALTER TABLE notebook_receipts ADD FOREIGN KEY (org_id, post_id) REFERENCES notebook_posts (org_id, id);
ALTER TABLE notebook_receipts ADD FOREIGN KEY (org_id, user_id) REFERENCES memberships (org_id, user_id);
ALTER TABLE source_document_moves ADD FOREIGN KEY (org_id, document_id) REFERENCES source_documents (org_id, id);
ALTER TABLE source_document_moves ADD FOREIGN KEY (org_id, moved_by) REFERENCES memberships (org_id, user_id);

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
  PERFORM setval(pg_get_serial_sequence('project_stage_events', 'id'), COALESCE(MAX(id), 0) + 1, false) FROM project_stage_events;
  PERFORM setval(pg_get_serial_sequence('cashflow_categories', 'id'), COALESCE(MAX(id), 0) + 1, false) FROM cashflow_categories;
  PERFORM setval(pg_get_serial_sequence('yojitsu_periods', 'id'), COALESCE(MAX(id), 0) + 1, false) FROM yojitsu_periods;
  PERFORM setval(pg_get_serial_sequence('yojitsu_target_versions', 'id'), COALESCE(MAX(id), 0) + 1, false) FROM yojitsu_target_versions;
  PERFORM setval(pg_get_serial_sequence('yojitsu_plan_versions', 'id'), COALESCE(MAX(id), 0) + 1, false) FROM yojitsu_plan_versions;
  PERFORM setval(pg_get_serial_sequence('plan_adoptions', 'id'), COALESCE(MAX(id), 0) + 1, false) FROM plan_adoptions;
  PERFORM setval(pg_get_serial_sequence('yojitsu_setting_versions', 'id'), COALESCE(MAX(id), 0) + 1, false) FROM yojitsu_setting_versions;
  PERFORM setval(pg_get_serial_sequence('yojitsu_forecast_versions', 'id'), COALESCE(MAX(id), 0) + 1, false) FROM yojitsu_forecast_versions;
  PERFORM setval(pg_get_serial_sequence('yojitsu_activity_records', 'id'), COALESCE(MAX(id), 0) + 1, false) FROM yojitsu_activity_records;
  PERFORM setval(pg_get_serial_sequence('kpi_metric_versions', 'id'), COALESCE(MAX(id), 0) + 1, false) FROM kpi_metric_versions;
  PERFORM setval(pg_get_serial_sequence('yojitsu_choice_versions', 'id'), COALESCE(MAX(id), 0) + 1, false) FROM yojitsu_choice_versions;
  PERFORM setval(pg_get_serial_sequence('sales_source_file_terms', 'id'), COALESCE(MAX(id), 0) + 1, false) FROM sales_source_file_terms;
  PERFORM setval(pg_get_serial_sequence('report_check_versions', 'id'), COALESCE(MAX(id), 0) + 1, false) FROM report_check_versions;
  PERFORM setval(pg_get_serial_sequence('report_check_cases', 'id'), COALESCE(MAX(id), 0) + 1, false) FROM report_check_cases;
  PERFORM setval(pg_get_serial_sequence('source_check_runs', 'id'), COALESCE(MAX(id), 0) + 1, false) FROM source_check_runs;
  PERFORM setval(pg_get_serial_sequence('source_sampling_reviews', 'id'), COALESCE(MAX(id), 0) + 1, false) FROM source_sampling_reviews;
  PERFORM setval(pg_get_serial_sequence('budget_versions', 'id'), COALESCE(MAX(id), 0) + 1, false) FROM budget_versions;
  PERFORM setval(pg_get_serial_sequence('budget_version_lines', 'id'), COALESCE(MAX(id), 0) + 1, false) FROM budget_version_lines;
  PERFORM setval(pg_get_serial_sequence('budget_check_runs', 'id'), COALESCE(MAX(id), 0) + 1, false) FROM budget_check_runs;
  PERFORM setval(pg_get_serial_sequence('budget_fixes', 'id'), COALESCE(MAX(id), 0) + 1, false) FROM budget_fixes;
  PERFORM setval(pg_get_serial_sequence('source_documents', 'id'), COALESCE(MAX(id), 0) + 1, false) FROM source_documents;
  PERFORM setval(pg_get_serial_sequence('acq_mg_contracts', 'id'), COALESCE(MAX(id), 0) + 1, false) FROM acq_mg_contracts;
  PERFORM setval(pg_get_serial_sequence('acq_mg_term_versions', 'id'), COALESCE(MAX(id), 0) + 1, false) FROM acq_mg_term_versions;
  PERFORM setval(pg_get_serial_sequence('acq_mg_report_links', 'id'), COALESCE(MAX(id), 0) + 1, false) FROM acq_mg_report_links;
  PERFORM setval(pg_get_serial_sequence('acq_mg_statements', 'id'), COALESCE(MAX(id), 0) + 1, false) FROM acq_mg_statements;
  PERFORM setval(pg_get_serial_sequence('acq_mg_documents', 'id'), COALESCE(MAX(id), 0) + 1, false) FROM acq_mg_documents;
  PERFORM setval(pg_get_serial_sequence('acq_mg_payments', 'id'), COALESCE(MAX(id), 0) + 1, false) FROM acq_mg_payments;
  PERFORM setval(pg_get_serial_sequence('budget_templates', 'id'), COALESCE(MAX(id), 0) + 1, false) FROM budget_templates;
  PERFORM setval(pg_get_serial_sequence('budget_template_versions', 'id'), COALESCE(MAX(id), 0) + 1, false) FROM budget_template_versions;
  PERFORM setval(pg_get_serial_sequence('budget_template_items', 'id'), COALESCE(MAX(id), 0) + 1, false) FROM budget_template_items;
  PERFORM setval(pg_get_serial_sequence('budget_line_items', 'id'), COALESCE(MAX(id), 0) + 1, false) FROM budget_line_items;
  PERFORM setval(pg_get_serial_sequence('expense_file_placements', 'id'), COALESCE(MAX(id), 0) + 1, false) FROM expense_file_placements;
  PERFORM setval(pg_get_serial_sequence('expense_month_closures', 'id'), COALESCE(MAX(id), 0) + 1, false) FROM expense_month_closures;
  PERFORM setval(pg_get_serial_sequence('committee_term_templates', 'id'), COALESCE(MAX(id), 0) + 1, false) FROM committee_term_templates;
  PERFORM setval(pg_get_serial_sequence('committee_schedule_versions', 'id'), COALESCE(MAX(id), 0) + 1, false) FROM committee_schedule_versions;
  PERFORM setval(pg_get_serial_sequence('committee_round_overrides', 'id'), COALESCE(MAX(id), 0) + 1, false) FROM committee_round_overrides;
  PERFORM setval(pg_get_serial_sequence('committee_ledger_entries', 'id'), COALESCE(MAX(id), 0) + 1, false) FROM committee_ledger_entries;
  PERFORM setval(pg_get_serial_sequence('bank_accounts', 'id'), COALESCE(MAX(id), 0) + 1, false) FROM bank_accounts;
  PERFORM setval(pg_get_serial_sequence('bank_statement_imports', 'id'), COALESCE(MAX(id), 0) + 1, false) FROM bank_statement_imports;
  PERFORM setval(pg_get_serial_sequence('bank_statement_lines', 'id'), COALESCE(MAX(id), 0) + 1, false) FROM bank_statement_lines;
  PERFORM setval(pg_get_serial_sequence('journal_entries', 'id'), COALESCE(MAX(id), 0) + 1, false) FROM journal_entries;
  PERFORM setval(pg_get_serial_sequence('journal_lines', 'id'), COALESCE(MAX(id), 0) + 1, false) FROM journal_lines;
  PERFORM setval(pg_get_serial_sequence('mfg_products', 'id'), COALESCE(MAX(id), 0) + 1, false) FROM mfg_products;
  PERFORM setval(pg_get_serial_sequence('mfg_product_versions', 'id'), COALESCE(MAX(id), 0) + 1, false) FROM mfg_product_versions;
  PERFORM setval(pg_get_serial_sequence('mfg_step_events', 'id'), COALESCE(MAX(id), 0) + 1, false) FROM mfg_step_events;
  PERFORM setval(pg_get_serial_sequence('mfg_purchase_orders', 'id'), COALESCE(MAX(id), 0) + 1, false) FROM mfg_purchase_orders;
  PERFORM setval(pg_get_serial_sequence('mfg_purchase_order_lines', 'id'), COALESCE(MAX(id), 0) + 1, false) FROM mfg_purchase_order_lines;
  PERFORM setval(pg_get_serial_sequence('mfg_po_events', 'id'), COALESCE(MAX(id), 0) + 1, false) FROM mfg_po_events;
  PERFORM setval(pg_get_serial_sequence('mfg_receipts', 'id'), COALESCE(MAX(id), 0) + 1, false) FROM mfg_receipts;
  PERFORM setval(pg_get_serial_sequence('mfg_po_expenses', 'id'), COALESCE(MAX(id), 0) + 1, false) FROM mfg_po_expenses;
  PERFORM setval(pg_get_serial_sequence('produce_tasks', 'id'), COALESCE(MAX(id), 0) + 1, false) FROM produce_tasks;
  PERFORM setval(pg_get_serial_sequence('produce_task_events', 'id'), COALESCE(MAX(id), 0) + 1, false) FROM produce_task_events;
  PERFORM setval(pg_get_serial_sequence('produce_task_checks', 'id'), COALESCE(MAX(id), 0) + 1, false) FROM produce_task_checks;
  PERFORM setval(pg_get_serial_sequence('produce_task_posts', 'id'), COALESCE(MAX(id), 0) + 1, false) FROM produce_task_posts;
  PERFORM setval(pg_get_serial_sequence('produce_task_links', 'id'), COALESCE(MAX(id), 0) + 1, false) FROM produce_task_links;
  PERFORM setval(pg_get_serial_sequence('produce_task_templates', 'id'), COALESCE(MAX(id), 0) + 1, false) FROM produce_task_templates;
  PERFORM setval(pg_get_serial_sequence('produce_task_template_items', 'id'), COALESCE(MAX(id), 0) + 1, false) FROM produce_task_template_items;
  PERFORM setval(pg_get_serial_sequence('post_cuts', 'id'), COALESCE(MAX(id), 0) + 1, false) FROM post_cuts;
  PERFORM setval(pg_get_serial_sequence('post_notes', 'id'), COALESCE(MAX(id), 0) + 1, false) FROM post_notes;
  PERFORM setval(pg_get_serial_sequence('post_note_actions', 'id'), COALESCE(MAX(id), 0) + 1, false) FROM post_note_actions;
  PERFORM setval(pg_get_serial_sequence('post_tasks', 'id'), COALESCE(MAX(id), 0) + 1, false) FROM post_tasks;
  PERFORM setval(pg_get_serial_sequence('post_task_events', 'id'), COALESCE(MAX(id), 0) + 1, false) FROM post_task_events;
  PERFORM setval(pg_get_serial_sequence('post_deliverable_items', 'id'), COALESCE(MAX(id), 0) + 1, false) FROM post_deliverable_items;
  PERFORM setval(pg_get_serial_sequence('post_deliverable_events', 'id'), COALESCE(MAX(id), 0) + 1, false) FROM post_deliverable_events;
  PERFORM setval(pg_get_serial_sequence('sales_proposals', 'id'), COALESCE(MAX(id), 0) + 1, false) FROM sales_proposals;
  PERFORM setval(pg_get_serial_sequence('sales_proposal_reviews', 'id'), COALESCE(MAX(id), 0) + 1, false) FROM sales_proposal_reviews;
  PERFORM setval(pg_get_serial_sequence('sales_activity_notes', 'id'), COALESCE(MAX(id), 0) + 1, false) FROM sales_activity_notes;
  PERFORM setval(pg_get_serial_sequence('planning_documents', 'id'), COALESCE(MAX(id), 0) + 1, false) FROM planning_documents;
  PERFORM setval(pg_get_serial_sequence('planning_profile_versions', 'id'), COALESCE(MAX(id), 0) + 1, false) FROM planning_profile_versions;
  PERFORM setval(pg_get_serial_sequence('planning_profile_people', 'id'), COALESCE(MAX(id), 0) + 1, false) FROM planning_profile_people;
  PERFORM setval(pg_get_serial_sequence('planning_trial_versions', 'id'), COALESCE(MAX(id), 0) + 1, false) FROM planning_trial_versions;
  PERFORM setval(pg_get_serial_sequence('planning_trial_rates', 'id'), COALESCE(MAX(id), 0) + 1, false) FROM planning_trial_rates;
  PERFORM setval(pg_get_serial_sequence('planning_trial_lines', 'id'), COALESCE(MAX(id), 0) + 1, false) FROM planning_trial_lines;
  PERFORM setval(pg_get_serial_sequence('planning_trial_investments', 'id'), COALESCE(MAX(id), 0) + 1, false) FROM planning_trial_investments;
  PERFORM setval(pg_get_serial_sequence('project_owner_versions', 'id'), COALESCE(MAX(id), 0) + 1, false) FROM project_owner_versions;
  PERFORM setval(pg_get_serial_sequence('planning_materials', 'id'), COALESCE(MAX(id), 0) + 1, false) FROM planning_materials;
  PERFORM setval(pg_get_serial_sequence('planning_facts', 'id'), COALESCE(MAX(id), 0) + 1, false) FROM planning_facts;
  PERFORM setval(pg_get_serial_sequence('shooting_scene_results', 'id'), COALESCE(MAX(id), 0) + 1, false) FROM shooting_scene_results;
  PERFORM setval(pg_get_serial_sequence('shooting_day_records', 'id'), COALESCE(MAX(id), 0) + 1, false) FROM shooting_day_records;
  PERFORM setval(pg_get_serial_sequence('shooting_day_report_items', 'id'), COALESCE(MAX(id), 0) + 1, false) FROM shooting_day_report_items;
  PERFORM setval(pg_get_serial_sequence('chotatsu_cases', 'id'), COALESCE(MAX(id), 0) + 1, false) FROM chotatsu_cases;
  PERFORM setval(pg_get_serial_sequence('chotatsu_case_versions', 'id'), COALESCE(MAX(id), 0) + 1, false) FROM chotatsu_case_versions;
  PERFORM setval(pg_get_serial_sequence('chotatsu_stage_events', 'id'), COALESCE(MAX(id), 0) + 1, false) FROM chotatsu_stage_events;
  PERFORM setval(pg_get_serial_sequence('chotatsu_estimates', 'id'), COALESCE(MAX(id), 0) + 1, false) FROM chotatsu_estimates;
  PERFORM setval(pg_get_serial_sequence('chotatsu_estimate_lines', 'id'), COALESCE(MAX(id), 0) + 1, false) FROM chotatsu_estimate_lines;
  PERFORM setval(pg_get_serial_sequence('chotatsu_agreements', 'id'), COALESCE(MAX(id), 0) + 1, false) FROM chotatsu_agreements;
  PERFORM setval(pg_get_serial_sequence('chotatsu_ringi', 'id'), COALESCE(MAX(id), 0) + 1, false) FROM chotatsu_ringi;
  PERFORM setval(pg_get_serial_sequence('chotatsu_contracts', 'id'), COALESCE(MAX(id), 0) + 1, false) FROM chotatsu_contracts;
  PERFORM setval(pg_get_serial_sequence('chotatsu_materials', 'id'), COALESCE(MAX(id), 0) + 1, false) FROM chotatsu_materials;
  PERFORM setval(pg_get_serial_sequence('chotatsu_handoffs', 'id'), COALESCE(MAX(id), 0) + 1, false) FROM chotatsu_handoffs;
  PERFORM setval(pg_get_serial_sequence('chotatsu_handoff_events', 'id'), COALESCE(MAX(id), 0) + 1, false) FROM chotatsu_handoff_events;
  PERFORM setval(pg_get_serial_sequence('chotatsu_documents', 'id'), COALESCE(MAX(id), 0) + 1, false) FROM chotatsu_documents;
  PERFORM setval(pg_get_serial_sequence('chotatsu_case_expenses', 'id'), COALESCE(MAX(id), 0) + 1, false) FROM chotatsu_case_expenses;
  PERFORM setval(pg_get_serial_sequence('production_arrangement_versions', 'id'), COALESCE(MAX(id), 0) + 1, false) FROM production_arrangement_versions;
  PERFORM setval(pg_get_serial_sequence('scene_art_item_versions', 'id'), COALESCE(MAX(id), 0) + 1, false) FROM scene_art_item_versions;
  PERFORM setval(pg_get_serial_sequence('scene_shoot_plan_versions', 'id'), COALESCE(MAX(id), 0) + 1, false) FROM scene_shoot_plan_versions;
  PERFORM setval(pg_get_serial_sequence('preprod_document_placements', 'id'), COALESCE(MAX(id), 0) + 1, false) FROM preprod_document_placements;
  PERFORM setval(pg_get_serial_sequence('notebook_spaces', 'id'), COALESCE(MAX(id), 0) + 1, false) FROM notebook_spaces;
  PERFORM setval(pg_get_serial_sequence('notebook_posts', 'id'), COALESCE(MAX(id), 0) + 1, false) FROM notebook_posts;
  PERFORM setval(pg_get_serial_sequence('notebook_receipts', 'id'), COALESCE(MAX(id), 0) + 1, false) FROM notebook_receipts;
  PERFORM setval(pg_get_serial_sequence('source_document_moves', 'id'), COALESCE(MAX(id), 0) + 1, false) FROM source_document_moves;
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
  VALUES ('pg-ddl 1', 'da1397bdcf276c793c2ad64d35b1f54e0a036c189a89a2dc2b1649d569582e6f', 'da1397bdcf276c793c2ad64d35b1f54e0a036c189a89a2dc2b1649d569582e6f', 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855', 'b1e432c82558960842275ec038f6002c5abc11701b3e505574e1540b55fdf6c8', '0056_source_document_moves.sql', 389, 912, 316, 238, 952, 256);
