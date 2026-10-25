-- integrated_app で、Worker を切り替える前（書き込み停止中）に流す。
-- 値・ロール名は出さず真偽だけ。search_path を変更せず接続の既定を検査する。
-- 表と IDENTITY の数は直書きせず、DB の版の印（schema_source_fingerprint の expected_tables・expected_identities）から読む。
-- 版の印がこの作業場の pg/schema.sql と同じことは、先に Default で流す catalog（pg-staging.ps1 -Action catalog）が確かめる。
-- 版の印の表そのものは expected_tables に入らないので、全表の数は expected_tables + 1。
SELECT current_database() = 'postgres' AS database_ok,
       current_schema() = 'public' AS schema_ok,
       (SELECT count(*) = (SELECT expected_tables + 1 FROM public.schema_source_fingerprint) AND count(DISTINCT c.relowner) = 1 AND bool_and(c.relowner <> current_user::regrole)
          FROM pg_class c WHERE c.relnamespace = 'public'::regnamespace AND c.relkind IN ('r','p')) AS owner_is_other_ok,
       NOT has_schema_privilege(current_user, 'public', 'CREATE') AS no_create_ok;

-- 全 IDENTITY の sequence を同じ値・同じ is_called で setval する。
-- sequence の変更は ROLLBACK では戻らないため、稼働中には流さない。
CREATE TEMP TABLE staging_permission_result(sequence_ok boolean NOT NULL);
DO $probe$
DECLARE r record; seq text; v bigint; called boolean; ok boolean := true; n integer := 0;
BEGIN
  FOR r IN SELECT table_name, column_name FROM information_schema.columns
           WHERE table_schema = 'public' AND is_identity = 'YES' LOOP
    n := n + 1;
    seq := pg_get_serial_sequence(format('public.%I', r.table_name), r.column_name);
    BEGIN
      EXECUTE format('SELECT last_value, is_called FROM %s', seq) INTO v, called;
      PERFORM setval(seq::regclass, v, called);
      PERFORM pg_sequence_last_value(seq::regclass);
    EXCEPTION WHEN insufficient_privilege THEN ok := false;
    END;
  END LOOP;
  INSERT INTO staging_permission_result VALUES(ok AND n = (SELECT expected_identities FROM public.schema_source_fingerprint));
END
$probe$;
SELECT sequence_ok FROM staging_permission_result;
DROP TABLE staging_permission_result;

-- 行単位の権限（pg/rls.sql）を当てたあとは、利用者 ID なしのアプリのロールに業務の行が1行も見えない（FR-CORE-DATA-053）。
-- 当てる前（projects に RLS が無い）は真。行の値は出さない
SELECT (SELECT NOT c.relrowsecurity FROM pg_class c WHERE c.oid = 'public.projects'::regclass) OR NOT EXISTS (SELECT 1 FROM public.projects) AS rls_closed_ok;
