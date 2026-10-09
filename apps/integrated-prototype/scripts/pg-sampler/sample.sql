-- 接続の見本（scripts/measure-staging.ps1。PG 計画 段2の実測 S6）。1秒ごとに1行の CSV（見出しなし）を書く:
--   時刻（UTC）,アプリのロールの接続数,そのうち active の最長の経過 ms,全体の接続数（client backend）,max_connections
-- アプリのロールは precheck.sql と同じ定義（名前を推測しない）。回数の上限は ps1 が -v limit=<回数> で渡す。
-- psql -1 は付けない（1つのトランザクションの中では pg_stat_activity が最初の値のまま変わらない）。
-- 最長の経過は1秒ごとの見本の下限（見本と見本のあいだに始まって終わったクエリは見えない）。Query Insights の Max latency で裏付ける
WITH app AS (
  SELECT r.oid FROM pg_roles r
  WHERE r.rolcanlogin
    AND NOT (r.rolsuper OR r.rolcreaterole OR r.rolcreatedb OR r.rolreplication OR r.rolbypassrls)
    AND ARRAY(SELECT g.rolname::text FROM pg_auth_members m JOIN pg_roles g ON g.oid = m.roleid WHERE m.member = r.oid ORDER BY 1)
      = ARRAY['pg_read_all_data', 'pg_write_all_data']::text[]
)
SELECT
  to_char(clock_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS.MS'),
  count(app.oid),
  COALESCE(max((EXTRACT(EPOCH FROM clock_timestamp() - s.query_start) * 1000)::bigint) FILTER (WHERE app.oid IS NOT NULL AND s.state = 'active'), 0),
  count(*) FILTER (WHERE s.backend_type = 'client backend'),
  current_setting('max_connections')::int
FROM pg_stat_activity s
LEFT JOIN app ON app.oid = s.usesysid
\watch i=1 c=:limit
