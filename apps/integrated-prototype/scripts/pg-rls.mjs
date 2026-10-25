// pg/schema.sql（生成物）の表から、行単位の権限（RLS）の DDL（pg/rls.sql）と、外して戻す DDL（pg/rls-off.sql）を生成する。
// 会社ルートの plans/2026-10-21-db-rls-owner-only.md の香盤表 #2・#5。scripts/pg-ddl.mjs が pg/schema.sql と一緒に書き、--check で一致を見る。
//
// - 業務の表（org_id を持つ表）は、いまの利用者が有効に所属する組織の行だけを、読む・作る・直す・消すことができる（USING と WITH CHECK に同じ条件）
// - 利用者 ID はトランザクションの設定値 app.user_id（BEGIN の直後に set_config(…, true) で置く）。無いか空なら、どの業務の行も通さない
// - 持ち主のロール（移行・復旧）は RLS の外。アプリのロール（integrated_app）は持ち主でなく BYPASSRLS も持たないので RLS がかかる
// - org_id を持たない表は、下の NON_ORG_TABLES に扱いを1つずつ書く。書いていない表が増えたら生成を止める（黙って開けない）
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const app = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const RLS_PATH = resolve(app, 'pg/rls.sql');
export const RLS_OFF_PATH = resolve(app, 'pg/rls-off.sql');
export const ORG_POLICY = 'rls_org_member';

// org_id を持たない表の扱い
// - shared: ログインした利用者（app.user_id がある）なら全員が読み書きできる共通のマスタ
// - users: 自分の行を直す。読むのはログインした利用者と、ログインの照会（app.login_email が同じメールの行）。招待の受け入れが別組織のメールを引くため
// - organizations: 所属する組織だけ読む。書くのは持ち主のロールだけ
// - outside: RLS をかけない（理由を書く）
export const NON_ORG_TABLES = Object.freeze({
  users: 'users',
  organizations: 'organizations',
  distribution_master: 'shared',
  distribution_types: 'shared',
  recognition_bases: 'shared',
  partner_list_kinds: 'shared',
  earning_types: 'shared',
  action_steps: 'shared',
  project_stages: 'shared',
  project_stage_meanings: 'shared',
  yojitsu_variables: 'shared',
  // 同時更新の止め（CHECK(value=1) の違反で一括を巻き戻す。行は残らない）。RLS をかけると違反の種類が check から変わり、db-errors.mjs の判定が崩れる
  transaction_guards: 'outside',
  // 版の印（src/data-platform/pg-fingerprint.mjs）。業務の値を持たない
  schema_source_fingerprint: 'outside',
});

// pg/schema.sql の CREATE TABLE から {name, columns} を順に取る
export function tablesOf(schemaSql) {
  const out = [];
  for (const m of schemaSql.matchAll(/CREATE TABLE (?:IF NOT EXISTS )?"?(\w+)"?\s*\(([\s\S]*?)\n\);/g)) {
    const columns = [...m[2].matchAll(/^\s+"?(\w+)"?\s/gm)].map((c) => c[1]);
    out.push({ name: m[1], columns });
  }
  return out;
}

const q = (name) => `"${name}"`;
const MEMBER = '((SELECT rls_member_org_ids())::bigint[])'; // 配列の式にする（括弧だけだと ANY の副問い合わせと読まれる）。SELECT で包んで要求ごとに1回だけ評価させる
const SIGNED_IN = 'rls_current_user_id() IS NOT NULL';

const HEADER = `-- 生成物（scripts/pg-rls.mjs が pg/schema.sql から作る）。手で直さない。
-- 行単位の権限（RLS）。会社ルートの plans/2026-10-21-db-rls-owner-only.md。
-- pg/schema.sql と同じ search_path で、表の持ち主のロールが当てる。アプリのロールは持ち主にしない。
-- 関数は表と同じ schema に置く（試験は schema ごと作って消すので、別の schema に置くと前の試験の表を指したまま残る）。

-- いまの利用者 ID。トランザクションの設定値 app.user_id（set_config(…, true)）。無いか空か数でなければ NULL（どの業務の行も通さない）
CREATE OR REPLACE FUNCTION rls_current_user_id() RETURNS bigint LANGUAGE sql STABLE AS $f$
  SELECT CASE WHEN current_setting('app.user_id', true) ~ '^[1-9][0-9]{0,17}$' THEN current_setting('app.user_id', true)::bigint END
$f$;

-- ログインの照会で使うメール（Cloudflare Access で確かめたもの）。無ければ NULL
CREATE OR REPLACE FUNCTION rls_login_email() RETURNS text LANGUAGE sql STABLE AS $f$
  SELECT NULLIF(current_setting('app.login_email', true), '')
$f$;

-- 所属の期限。読めない値は期限切れとして扱う（閉じる側に倒す）。アプリは Date.parse で同じ判定をする（src/session-org.mjs の activeAt）
CREATE OR REPLACE FUNCTION rls_not_expired(expires_at text) RETURNS boolean LANGUAGE plpgsql STABLE AS $f$
BEGIN
  IF expires_at IS NULL OR expires_at = '' THEN RETURN true; END IF;
  RETURN expires_at::timestamptz > statement_timestamp();
EXCEPTION WHEN others THEN
  RETURN false;
END
$f$;

-- いまの利用者が有効に所属する組織（active=1・期限内）。所属の表自身にも RLS がかかるので、持ち主の権限で読む（SECURITY DEFINER）
CREATE OR REPLACE FUNCTION rls_member_org_ids() RETURNS bigint[] LANGUAGE sql STABLE SECURITY DEFINER SET search_path FROM CURRENT AS $f$
  SELECT coalesce(array_agg(m.org_id ORDER BY m.org_id), '{}')
    FROM memberships m
   WHERE m.user_id = rls_current_user_id() AND m.active = 1 AND rls_not_expired(m.expires_at)
$f$;
`;

// 表ごとのポリシー（{name, cmd, using, check}）。null は RLS をかけない表（理由は NON_ORG_TABLES）
export function policiesFor({ name, columns }) {
  const org = `org_id = ANY ${MEMBER}`;
  if (columns.includes('org_id')) return [{ name: ORG_POLICY, cmd: null, using: org, check: org }];
  const kind = NON_ORG_TABLES[name];
  if (kind === 'shared') return [{ name: 'rls_signed_in', cmd: null, using: SIGNED_IN, check: SIGNED_IN }];
  if (kind === 'users') {
    return [
      { name: 'rls_users_read', cmd: 'SELECT', using: `${SIGNED_IN} OR email = rls_login_email()`, check: null },
      { name: 'rls_users_add', cmd: 'INSERT', using: null, check: SIGNED_IN },
      { name: 'rls_users_self', cmd: 'UPDATE', using: 'id = rls_current_user_id()', check: 'id = rls_current_user_id()' },
    ];
  }
  if (kind === 'organizations') return [{ name: 'rls_org_read', cmd: 'SELECT', using: `id = ANY ${MEMBER}`, check: null }];
  if (kind === 'outside') return null;
  throw new Error(`org_id を持たない表 ${name} の扱いが scripts/pg-rls.mjs の NON_ORG_TABLES にありません。読む人・書く人を決めて足してください`);
}

// 当て直しても止まらないように、作る前に同じ名前のポリシーを消す（CREATE POLICY に IF NOT EXISTS は無い）
function enableSql(table) {
  const policies = policiesFor(table);
  if (!policies) return `-- ${table.name}: RLS をかけない（scripts/pg-rls.mjs の NON_ORG_TABLES に理由）`;
  const lines = [`ALTER TABLE ${q(table.name)} ENABLE ROW LEVEL SECURITY;`];
  for (const p of policies) {
    lines.push(`DROP POLICY IF EXISTS ${p.name} ON ${q(table.name)};`);
    lines.push(`CREATE POLICY ${p.name} ON ${q(table.name)}${p.cmd ? ` FOR ${p.cmd}` : ''}${p.using ? ` USING (${p.using})` : ''}${p.check ? ` WITH CHECK (${p.check})` : ''};`);
  }
  return lines.join('\n');
}

function disableSql(table) {
  const policies = policiesFor(table);
  if (!policies) return null;
  return [...policies.map((p) => `DROP POLICY IF EXISTS ${p.name} ON ${q(table.name)};`), `ALTER TABLE ${q(table.name)} DISABLE ROW LEVEL SECURITY;`].join('\n');
}

function checkedTables(schemaSql) {
  const tables = tablesOf(schemaSql);
  const names = new Set(tables.map((t) => t.name));
  const stale = Object.keys(NON_ORG_TABLES).filter((n) => !names.has(n));
  if (stale.length) throw new Error(`NON_ORG_TABLES にあるのに pg/schema.sql に無い表: ${stale.join(', ')}`);
  return tables;
}

// pg/schema.sql の文 → pg/rls.sql の文
export function buildRlsSql(schemaSql) {
  const body = checkedTables(schemaSql).map((t) => `-- ${t.name}\n${enableSql(t)}`).join('\n\n');
  return `${HEADER}
${body}
`;
}

// pg/schema.sql の文 → pg/rls-off.sql の文（RLS を外して前の状態へ戻す。関数は残す。どのポリシーも参照しなくなるので害が無い）
export function buildRlsOffSql(schemaSql) {
  const body = checkedTables(schemaSql).map(disableSql).filter(Boolean).join('\n\n');
  return `-- 生成物（scripts/pg-rls.mjs が pg/schema.sql から作る）。手で直さない。
-- 行単位の権限（pg/rls.sql）を外して戻す。表の持ち主のロールが、1つのトランザクションで当てる（core の runbooks/16-rls-staging.md の戻し方）。
-- 外したあとは、アプリのロールが全組織の行を読み書きできる（RLS を入れる前と同じ）。関数 rls_* は残す。

${body}
`;
}
