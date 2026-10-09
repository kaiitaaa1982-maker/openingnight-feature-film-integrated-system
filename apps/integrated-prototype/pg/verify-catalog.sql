-- pg/schema.sql を当てた PostgreSQL のカタログを、版の印の表（schema_source_fingerprint。scripts/pg-ddl.mjs が pg/schema.sql の最後に作る）と並べる。
-- 手で書く（生成物ではない）。香盤表 #27・段2の準備 論点9。代表が staging・本番に DDL を当てたあと、同じ DB・同じスキーマで流して出力を Claude に渡す。
-- CI（.github/workflows/ci.yml の integrated-postgres）と試験（test/pg-catalog.test.mjs）も流す。
--
-- 出すのは数と指紋と current_schema() だけで、業務の表の行の中身は読まない（版の印の表だけを読む）。1つの SELECT で、行は次の4列:
--   ord      並びの番号
--   item     項目（tables・triggers・functions・identities・foreign_keys・indexes は数。ほかは印）
--   actual   いまの DB の値（文字）
--   expected 版の印が期待する値（数の項目だけ。印の項目は NULL で、リポジトリの pg/schema.sql の印の行と見比べる）
--   ok       actual と expected が等しいか（数の項目だけ。印の項目は NULL）。数の項目が1つでも false なら、当てた DDL が足りないか余計なものがある
-- 数え方（いまのスキーマ current_schema() の中だけ。版の印の表そのものは数えない）:
--   tables       普通の表（relkind r・p）
--   triggers     利用者が作ったトリガー（内部の FK のトリガーを除く）
--   functions    関数（lite_* の補助と、トリガーごとの PL/pgSQL の関数）
--   identities   IDENTITY の列
--   foreign_keys 外部キーの制約
--   indexes      その表の主キー・UNIQUE の制約の裏の索引ではない索引（CREATE INDEX で作ったもの。外部キーが参照する一意の索引も数える）
-- psql の例: psql -v ON_ERROR_STOP=1 -X -f pg/verify-catalog.sql
WITH f AS (
  SELECT * FROM schema_source_fingerprint
), rel AS (
  SELECT c.oid, c.relname FROM pg_class c
  WHERE c.relnamespace = current_schema()::regnamespace AND c.relkind IN ('r', 'p') AND c.relname <> 'schema_source_fingerprint'
), counted AS (
  SELECT 'tables' AS item, (SELECT count(*) FROM rel) AS n, (SELECT expected_tables FROM f) AS e
  UNION ALL
  SELECT 'triggers', (SELECT count(*) FROM pg_trigger t JOIN rel ON rel.oid = t.tgrelid WHERE NOT t.tgisinternal), (SELECT expected_triggers FROM f)
  UNION ALL
  SELECT 'functions', (SELECT count(*) FROM pg_proc p WHERE p.pronamespace = current_schema()::regnamespace), (SELECT expected_functions FROM f)
  UNION ALL
  SELECT 'identities', (SELECT count(*) FROM pg_attribute a JOIN rel ON rel.oid = a.attrelid WHERE a.attnum > 0 AND NOT a.attisdropped AND a.attidentity <> ''), (SELECT expected_identities FROM f)
  UNION ALL
  SELECT 'foreign_keys', (SELECT count(*) FROM pg_constraint k JOIN rel ON rel.oid = k.conrelid WHERE k.contype = 'f'), (SELECT expected_foreign_keys FROM f)
  UNION ALL
  SELECT 'indexes', (SELECT count(*) FROM pg_index x JOIN rel ON rel.oid = x.indrelid WHERE NOT EXISTS (SELECT 1 FROM pg_constraint k WHERE k.conindid = x.indexrelid AND k.conrelid = x.indrelid AND k.contype IN ('p', 'u', 'x'))), (SELECT expected_indexes FROM f)
)
SELECT 1 AS ord, 'current_schema' AS item, current_schema()::text AS actual, NULL::text AS expected, NULL::boolean AS ok
UNION ALL SELECT 2, 'fingerprint_rows', (SELECT count(*) FROM f)::text, '1', (SELECT count(*) FROM f) = 1
UNION ALL SELECT 3, 'generator', (SELECT generator FROM f), NULL, NULL
UNION ALL SELECT 4, 'last_migration', (SELECT last_migration FROM f), NULL, NULL
UNION ALL SELECT 5, 'source_sha256', (SELECT source_sha256 FROM f), NULL, NULL
UNION ALL SELECT 6, 'migrations_sha256', (SELECT migrations_sha256 FROM f), NULL, NULL
UNION ALL SELECT 7, 'app_ddl_sha256', (SELECT app_ddl_sha256 FROM f), NULL, NULL
UNION ALL SELECT 8, 'ddl_sha256', (SELECT ddl_sha256 FROM f), NULL, NULL
UNION ALL SELECT 8 + row_number() OVER (ORDER BY CASE item WHEN 'tables' THEN 1 WHEN 'triggers' THEN 2 WHEN 'functions' THEN 3 WHEN 'identities' THEN 4 WHEN 'foreign_keys' THEN 5 ELSE 6 END),
  item, n::text, e::text, n = e
  FROM counted
ORDER BY ord;
