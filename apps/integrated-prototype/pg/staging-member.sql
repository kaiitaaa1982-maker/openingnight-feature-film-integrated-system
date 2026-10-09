-- psql の member_email 変数は代表が入力する。メールの値をこのファイルへ書かない。
-- seed の後、管理用の接続で -1・ON_ERROR_STOP=1 を付けて流す。
INSERT INTO transaction_guards(value) SELECT 0 WHERE
  (SELECT count(*) FROM organizations WHERE id=1 AND code='DEMO-SALES') <> 1;
INSERT INTO users(email,display_name) VALUES (:'member_email','staging 管理者') ON CONFLICT(email) DO NOTHING;
INSERT INTO memberships(org_id,user_id,role,active)
  SELECT 1,id,'admin',1 FROM users WHERE email=:'member_email'
  ON CONFLICT(org_id,user_id) DO UPDATE SET role='admin',active=1,expires_at=NULL;
SELECT EXISTS(SELECT 1 FROM memberships m JOIN users u ON u.id=m.user_id
  WHERE m.org_id=1 AND u.email=:'member_email' AND m.role='admin' AND m.active=1 AND m.expires_at IS NULL) AS membership_ok;
