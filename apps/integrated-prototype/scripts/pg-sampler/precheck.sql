-- 接続の見本取りの前の確かめ（scripts/measure-staging.ps1。PG 計画 段2の実測 S6）。1行を返す: アプリのロールの数,pg_read_all_stats を使えるか
-- アプリのロール（staging・本番の integrated_app）は名前を推測せず、scripts/pg-role-check.mjs と同じ定義で決める:
-- ログインでき、属するロールがちょうど pg_read_all_data と pg_write_all_data で、rolsuper・rolcreaterole・rolcreatedb・
-- rolreplication・rolbypassrls がすべて偽。ちょうど1つでなければ、見本取りは止める（どの接続を数えるか決まらない）。
-- pg_read_all_stats を使えないと、ほかのロールの接続の状態（state・query_start）が見えない
SELECT
  (SELECT count(*) FROM pg_roles r
    WHERE r.rolcanlogin
      AND NOT (r.rolsuper OR r.rolcreaterole OR r.rolcreatedb OR r.rolreplication OR r.rolbypassrls)
      AND ARRAY(SELECT g.rolname::text FROM pg_auth_members m JOIN pg_roles g ON g.oid = m.roleid WHERE m.member = r.oid ORDER BY 1)
        = ARRAY['pg_read_all_data', 'pg_write_all_data']::text[]) AS app_roles,
  pg_has_role(current_user, 'pg_read_all_stats', 'USAGE') AS read_all_stats;
