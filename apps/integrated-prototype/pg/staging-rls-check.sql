-- 行単位の権限（pg/rls.sql）を当てた直後、同じトランザクションの中で表の持ち主（Default）が流す（scripts/pg-staging.ps1 -Action rls。core の runbooks/16-rls-staging.md）。
-- 値・ロールの名前は出さず、名前|真偽 の6行だけを出す。1つでも f なら rls_check_failed で止め、pg/rls.sql ごと巻き戻す
-- （書き出しのロールが無いまま RLS が効くと、日次の書き出しが 42501 で失敗し続けるため）。
-- ロールは名前の頭で探す（PlanetScale は Username に印を足すことがある）。
CREATE TEMP TABLE staging_rls_check(name text NOT NULL, ok boolean NOT NULL) ON COMMIT DROP;
INSERT INTO staging_rls_check VALUES
  ('tables_ok', NOT EXISTS (
     SELECT 1 FROM pg_class c
      WHERE c.relnamespace = 'public'::regnamespace AND c.relkind IN ('r','p') AND NOT c.relrowsecurity
        AND c.relname NOT IN ('transaction_guards', 'schema_source_fingerprint'))),
  ('outside_ok', (SELECT count(*) = 2 FROM pg_class c
      WHERE c.relnamespace = 'public'::regnamespace AND c.relkind IN ('r','p') AND NOT c.relrowsecurity)),
  ('policies_ok', NOT EXISTS (
     SELECT 1 FROM pg_class c
      WHERE c.relnamespace = 'public'::regnamespace AND c.relkind IN ('r','p') AND c.relrowsecurity
        AND NOT EXISTS (SELECT 1 FROM pg_policies p WHERE p.schemaname = 'public' AND p.tablename = c.relname))),
  ('member_function_ok', EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'rls_member_org_ids' AND pronamespace = 'public'::regnamespace AND prosecdef)),
  ('app_role_ok', EXISTS (SELECT 1 FROM pg_roles WHERE rolname LIKE 'integrated\_app%')
     AND NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname LIKE 'integrated\_app%' AND (rolbypassrls OR rolsuper))),
  ('export_role_ok', EXISTS (SELECT 1 FROM pg_roles WHERE rolname LIKE 'integrated\_export%' AND rolbypassrls AND NOT rolsuper));
SELECT name || '|' || CASE WHEN ok THEN 't' ELSE 'f' END FROM staging_rls_check ORDER BY name;
DO $check$ BEGIN
  IF EXISTS (SELECT 1 FROM staging_rls_check WHERE NOT ok) THEN RAISE EXCEPTION 'rls_check_failed'; END IF;
END $check$;
