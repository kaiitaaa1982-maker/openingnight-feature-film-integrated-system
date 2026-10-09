// 組織の切替（Cookie on_org＝「利用者ID:組織ID」）。既定は org_id が最小の所属、選んだ組織は毎回の要求で所属を確かめ直す。
// 画面は描いている組織を X-On-Org に載せ、サーバーの組織と食い違えば /api/session 系のほかは読み書きとも 409。
import test from 'node:test';
import assert from 'node:assert/strict';
import {openTestDb} from './test-db.mjs';
import {createApp} from '../src/app.mjs';
import {
  ORG_COOKIE, ORG_HEADER, ORG_MISMATCH_CODE, ORG_CHECK_EXEMPT_PATHS, requestedOrgId, chooseMembership, activeMemberships,
  identityForEmail, orgCookieOptions, orgCookieValue, orgMismatch,
} from '../src/session-org.mjs';

const fixture = async ({t}, mode = 'local', authenticate) => {
  const db = await openTestDb({t});
  return {db, app: createApp({db, mode, authenticate})};
};
async function login(app, email = 'admin@openingnight.invalid', cookie) {
  const response = await app.request('/api/local/login', {method: 'POST', headers: {'content-type': 'application/json', ...(cookie ? {cookie} : {})}, body: JSON.stringify({email})});
  assert.equal(response.status, 200, email);
  return response.headers.get('set-cookie').split(';')[0];
}
const req = (app, path, cookie, options = {}) => app.request(`/api${path}`, {...options, headers: {...(options.body ? {'content-type': 'application/json'} : {}), ...(cookie ? {cookie} : {}), ...(options.headers || {})}});
const read = async (response) => ({status: response.status, body: await response.json(), setCookie: response.headers.get('set-cookie') || ''});
// 画面が描いている組織を載せた要求（ブラウザの画面と同じ）
const screen = (orgId) => ({[ORG_HEADER]: String(orgId)});
// 組織を切り替え、返ってきた on_org の Cookie を足した Cookie ヘッダーを返す
async function switchOrg(app, sessionCookie, orgId, url) {
  const response = url
    ? await app.request(url, {method: 'POST', headers: {'content-type': 'application/json', cookie: sessionCookie}, body: JSON.stringify({orgId})})
    : await req(app, '/session/org', sessionCookie, {method: 'POST', body: JSON.stringify({orgId})});
  const result = await read(response);
  const org = /(?:^|,\s*)on_org=([^;]*)/.exec(result.setCookie)?.[1];
  // ブラウザと同じく、前の on_org は新しい値で置き換える
  const base = sessionCookie.split(/;\s*/).filter((part) => !part.startsWith(`${ORG_COOKIE}=`)).join('; ');
  return {...result, cookie: org !== undefined ? `${base}; ${ORG_COOKIE}=${org}` : sessionCookie};
}
const session = async (app, cookie) => (await read(await req(app, '/session', cookie))).body.user;
const workIds = async (app, cookie, headers) => (await read(await req(app, '/bootstrap', cookie, {headers}))).body.works.map((work) => work.id);
const orgCookie = (userId, orgId) => `${ORG_COOKIE}=${encodeURIComponent(orgCookieValue(userId, orgId))}`;
const count = async (db, sql, params = []) => Number((await db.get(sql, params)).n);

test('requestedOrgId reads only a well-formed on_org cookie chosen by the same user', () => {
  assert.equal(orgCookieValue(1, 2), '1:2');
  assert.equal(requestedOrgId('on_org=1%3A2', 1), 2);
  assert.equal(requestedOrgId('on_org=1:2', 1), 2);
  assert.equal(requestedOrgId('on_session=abc; on_org=7%3A3; theme=dark', 7), 3);
  assert.equal(requestedOrgId('on_org= 1:4 ', 1), 4);
  // 別の利用者が選んだ組織・利用者の無い値（以前の形）は使わない
  assert.equal(requestedOrgId('on_org=1%3A2', 2), null);
  assert.equal(requestedOrgId('on_org=2', 1), null);
  assert.equal(requestedOrgId('on_org=1%3A2'), null);
  for (const header of ['', null, undefined, 'on_session=x', 'on_org=', 'on_org=1:0', 'on_org=1:-1', 'on_org=1:1.5', 'on_org=1:abc', 'on_org=%E0%A4%A', 'xon_org=1:2', 'on_org=1:9999999999999999', 'on_org=1:2:3', 'on_org=:2']) {
    assert.equal(requestedOrgId(header, 1), null, String(header));
  }
});

test('chooseMembership uses the requested org only when it is one of the memberships, else the first (lowest org_id)', () => {
  const memberships = [{org_id: 1, role: 'production'}, {org_id: 2, role: 'admin'}];
  assert.equal(chooseMembership(memberships, null).org_id, 1);
  assert.equal(chooseMembership(memberships, 2).org_id, 2);
  assert.equal(chooseMembership(memberships, 3).org_id, 1);
  assert.equal(chooseMembership([], 1), null);
  assert.equal(chooseMembership(null, 1), null);
});

test('orgMismatch compares the screen org with the request org, and treats a silent fallback without a header as a mismatch', () => {
  const identity = {org_id: 1, requested_org_id: null, org_fallback: false};
  assert.equal(orgMismatch(identity, '1'), null);
  assert.equal(orgMismatch(identity, undefined), null, 'ヘッダーの無い要求（リンクのダウンロード・スクリプト）は照合しない');
  assert.deepEqual(orgMismatch(identity, '2'), {currentOrgId: 1, expectedOrgId: 2});
  assert.deepEqual(orgMismatch(identity, 'abc'), {currentOrgId: 1, expectedOrgId: null});
  const fallback = {org_id: 1, requested_org_id: 2, org_fallback: true};
  assert.deepEqual(orgMismatch(fallback, undefined), {currentOrgId: 1, expectedOrgId: 2});
  assert.equal(orgMismatch(fallback, '1'), null, '画面が既定の組織を描いていれば食い違いではない');
  assert.deepEqual(ORG_CHECK_EXEMPT_PATHS, ['/api/session', '/api/session/orgs', '/api/session/org']);
});

test('orgCookieOptions is HttpOnly, SameSite=Lax, and Secure only over https', () => {
  assert.deepEqual(orgCookieOptions('http://127.0.0.1:9141/api/session/org'), {httpOnly: true, sameSite: 'Lax', secure: false, path: '/', maxAge: 30 * 24 * 3600});
  assert.equal(orgCookieOptions('https://integrated.example/api/session/org').secure, true);
  assert.equal(orgCookieOptions('not a url').secure, false);
});

test('activeMemberships orders by org_id and drops inactive or expired memberships', async (t) => {
  const {db} = await fixture({t});
  await db.run("INSERT INTO organizations(id,code,name) VALUES(3,'demo-sales','架空データ（デモ）')");
  // 挿入の順（org 3 → 2 → 1）に関係なく org_id の順に並ぶ
  await db.run("INSERT INTO users(id,email,display_name) VALUES(9,'multi@openingnight.invalid','複数所属')");
  await db.run("INSERT INTO memberships(org_id,user_id,role) VALUES(3,9,'editor')");
  await db.run("INSERT INTO memberships(org_id,user_id,role,expires_at) VALUES(2,9,'admin','2000-01-01T00:00:00.000Z')");
  await db.run("INSERT INTO memberships(org_id,user_id,role,active) VALUES(1,9,'admin',0)");
  const rows = await activeMemberships(db, 9);
  assert.deepEqual(rows.map((row) => [row.org_id, row.role, row.org_code, row.org_name]), [[3, 'editor', 'demo-sales', '架空データ（デモ）']]);
  await db.run("UPDATE memberships SET active=1 WHERE org_id=1 AND user_id=9");
  await db.run("UPDATE memberships SET expires_at='2999-01-01T00:00:00.000Z' WHERE org_id=2 AND user_id=9");
  assert.deepEqual((await activeMemberships(db, 9)).map((row) => row.org_id), [1, 2, 3]);
  const identity = await identityForEmail(db, 'multi@openingnight.invalid', null);
  assert.deepEqual({org: identity.org_id, role: identity.role, user: identity.user_id, fallback: identity.org_fallback}, {org: 1, role: 'admin', user: 9, fallback: false});
  assert.equal((await identityForEmail(db, 'multi@openingnight.invalid', orgCookie(9, 3))).org_id, 3);
  // 別の利用者（1）が選んだ組織の Cookie は使わない（既定の組織。既定へ戻したことにもならない）
  const other = await identityForEmail(db, 'multi@openingnight.invalid', orgCookie(1, 3));
  assert.deepEqual({org: other.org_id, fallback: other.org_fallback}, {org: 1, fallback: false});
  assert.equal(await identityForEmail(db, 'nobody@openingnight.invalid', orgCookie(9, 1)), null);
});

test('login defaults to the lowest org_id membership, regardless of insertion order', async (t) => {
  const {db, app} = await fixture({t});
  await db.run("INSERT INTO users(id,email,display_name) VALUES(9,'multi@openingnight.invalid','複数所属')");
  await db.run("INSERT INTO memberships(org_id,user_id,role) VALUES(2,9,'editor')");
  await db.run("INSERT INTO memberships(org_id,user_id,role) VALUES(1,9,'admin')");
  const cookie = await login(app, 'multi@openingnight.invalid');
  const user = await session(app, cookie);
  assert.deepEqual({orgId: user.orgId, role: user.role}, {orgId: 1, role: 'admin'});
  assert.equal((await db.get("SELECT org_id FROM sessions")).org_id, 1);
  const orgs = await read(await req(app, '/session/orgs', cookie));
  assert.equal(orgs.status, 200);
  assert.equal(orgs.body.currentOrgId, 1);
  assert.deepEqual(orgs.body.orgs, [
    {id: 1, code: 'demo', name: 'オープニングナイト試作チーム', role: 'admin'},
    {id: 2, code: 'other', name: '別組織（境界検証）', role: 'editor'},
  ]);
  // 最小の所属が失効していれば、次に有効な所属で入る
  await db.run("UPDATE memberships SET expires_at='2000-01-01T00:00:00.000Z' WHERE org_id=1 AND user_id=9");
  const later = await login(app, 'multi@openingnight.invalid');
  assert.equal((await session(app, later)).orgId, 2);
});

test('a single-org user sees one org and cannot switch to an org they do not belong to', async (t) => {
  const {db, app} = await fixture({t});
  const editor = await login(app, 'editor@openingnight.invalid');
  const orgs = await read(await req(app, '/session/orgs', editor));
  assert.deepEqual(orgs.body.orgs.map((org) => org.id), [1]);
  for (const orgId of [2, 999]) {
    const refused = await switchOrg(app, editor, orgId);
    assert.equal(refused.status, 403, String(orgId));
    assert.match(refused.body.error, /所属していない組織/);
    assert.doesNotMatch(refused.setCookie, /on_org=/);
  }
  for (const orgId of [0, -1, 'abc', null, 1.5]) assert.equal((await switchOrg(app, editor, orgId)).status, 400, String(orgId));
  assert.equal((await session(app, editor)).orgId, 1);
  // 認証なしでは一覧も切替も使えない
  assert.equal((await req(app, '/session/orgs')).status, 401);
  assert.equal((await req(app, '/session/org', null, {method: 'POST', body: JSON.stringify({orgId: 1})})).status, 401);
  assert.equal(await count(db, 'SELECT count(*) AS n FROM org_switch_events'), 0);
});

test('switching org sets an HttpOnly Lax cookie bound to the user, changes identity and data, and switching back isolates org 2 data', async (t) => {
  const {db, app} = await fixture({t});
  await db.run("INSERT INTO memberships(org_id,user_id,role) VALUES(2,1,'admin')");
  await db.run(`INSERT INTO sale_lines(org_id,project_id,work_id,partner_id,sales_period_from,sales_period_to,accounting_month,description,amount_ex_tax,tax_amount,amount_inc_tax)
    VALUES(2,2,2,4,'2026-09-01','2026-09-30','2026-09','別組織の売上',50000,5000,55000)`);
  const admin = await login(app);
  assert.equal((await session(app, admin)).orgId, 1);
  assert.deepEqual(await workIds(app, admin), [1]);

  const toTwo = await switchOrg(app, admin, 2);
  assert.equal(toTwo.status, 200);
  assert.deepEqual(toTwo.body.org, {id: 2, code: 'other', name: '別組織（境界検証）', role: 'admin'});
  assert.match(toTwo.setCookie, /on_org=1%3A2/);
  assert.match(toTwo.setCookie, /HttpOnly/i);
  assert.match(toTwo.setCookie, /SameSite=Lax/i);
  assert.match(toTwo.setCookie, /Path=\//);
  assert.doesNotMatch(toTwo.setCookie, /Secure/i);
  assert.equal((await session(app, toTwo.cookie)).orgId, 2);
  assert.deepEqual(await workIds(app, toTwo.cookie, screen(2)), [2]);
  assert.equal((await read(await req(app, '/session/orgs', toTwo.cookie))).body.currentOrgId, 2);
  // 切替は org_switch_events に残し、業務データの変更の記録（audit_log）には入れない
  assert.deepEqual({...await db.get('SELECT org_id,user_id,from_org_id FROM org_switch_events')}, {org_id: 2, user_id: 1, from_org_id: 1});
  assert.equal(await count(db, "SELECT count(*) AS n FROM audit_log WHERE action='switch_org'"), 0);
  const inTwo = (await read(await req(app, '/works', toTwo.cookie, {headers: screen(2)}))).body.rows.map((row) => row.id);
  assert.deepEqual(inTwo, [2]);
  const salesInTwo = await read(await req(app, '/sales', toTwo.cookie, {headers: screen(2)}));
  assert.equal(salesInTwo.status, 200);
  assert.ok(JSON.stringify(salesInTwo.body).includes('別組織の売上'));

  // 戻すと、org 2 の作品・売上は見えない
  const back = await switchOrg(app, toTwo.cookie, 1);
  assert.equal(back.status, 200);
  assert.match(back.setCookie, /on_org=1%3A1/);
  assert.equal((await session(app, back.cookie)).orgId, 1);
  assert.deepEqual(await workIds(app, back.cookie, screen(1)), [1]);
  assert.deepEqual((await read(await req(app, '/works', back.cookie))).body.rows.map((row) => row.id), [1]);
  assert.equal((await req(app, '/downloads/publicity?workId=2', back.cookie)).status, 403);
  const listed = await read(await req(app, '/sales', back.cookie));
  assert.equal(listed.status, 200);
  assert.ok(!JSON.stringify(listed.body).includes('別組織の売上'));
  assert.equal(await count(db, 'SELECT count(*) AS n FROM org_switch_events'), 2);

  // 同じ組織への切替は Cookie を置き直すだけで、記録は増やさない
  const same = await switchOrg(app, back.cookie, 1);
  assert.equal(same.status, 200);
  assert.equal(await count(db, 'SELECT count(*) AS n FROM org_switch_events'), 2);
});

test('the org cookie is Secure over https', async (t) => {
  const {db, app} = await fixture({t});
  await db.run("INSERT INTO memberships(org_id,user_id,role) VALUES(2,1,'admin')");
  const admin = await login(app);
  const result = await switchOrg(app, admin, 2, 'https://integrated.example/api/session/org');
  assert.equal(result.status, 200);
  assert.match(result.setCookie, /Secure/);
  assert.match(result.setCookie, /HttpOnly/i);
  assert.match(result.setCookie, /SameSite=Lax/i);
});

// F1: 別のタブで組織を切り替えたあと、前の組織を描いたままの画面から書き込むと、黙って別の組織に入っていた
test('a stale screen (other org in X-On-Org) cannot read or write in the org another tab switched to', async (t) => {
  const {db, app} = await fixture({t});
  await db.run("INSERT INTO memberships(org_id,user_id,role) VALUES(2,1,'admin')");
  const admin = await login(app);
  // タブB: 組織2を描いている。タブA: そのあと組織1へ切り替えた（Cookie はブラウザで1つ）
  const tabB = await switchOrg(app, admin, 2);
  const tabA = await switchOrg(app, tabB.cookie, 1);
  const cookie = tabA.cookie;
  const partnersBefore = await count(db, 'SELECT count(*) AS n FROM partners');
  const auditBefore = await count(db, 'SELECT count(*) AS n FROM audit_log');

  const write = await read(await req(app, '/partners', cookie, {method: 'POST', headers: screen(2), body: JSON.stringify({code: 'DEMO-X', name: '架空の取引先', kind: 'other'})}));
  assert.equal(write.status, 409);
  assert.equal(write.body.code, ORG_MISMATCH_CODE);
  assert.equal(write.body.currentOrgId, 1);
  assert.match(write.body.error, /組織が切り替わった/);
  const fiscal = await read(await req(app, '/settings/fiscal', cookie, {method: 'PUT', headers: screen(2), body: JSON.stringify({fiscalStartMonth: 1})}));
  assert.equal(fiscal.status, 409);
  assert.equal(fiscal.body.code, ORG_MISMATCH_CODE);
  assert.equal(await count(db, 'SELECT count(*) AS n FROM partners'), partnersBefore, '取引先は増えない');
  assert.equal(await count(db, 'SELECT count(*) AS n FROM fiscal_settings'), 0, '年度設定は書き換わらない');
  assert.equal(await count(db, 'SELECT count(*) AS n FROM audit_log'), auditBefore);
  // 読み出しも止める（組織2の画面に組織1の数字を出さない）
  for (const path of ['/bootstrap', '/works', '/sales', '/settings/fiscal']) {
    const response = await read(await req(app, path, cookie, {headers: screen(2)}));
    assert.equal(response.status, 409, path);
    assert.equal(response.body.code, ORG_MISMATCH_CODE, path);
  }
  // 今の組織を知る API は照合しない（画面はここで今の組織を知って読み直す）
  assert.equal((await read(await req(app, '/session', cookie, {headers: screen(2)}))).body.user.orgId, 1);
  assert.equal((await read(await req(app, '/session/orgs', cookie, {headers: screen(2)}))).body.currentOrgId, 1);
  assert.equal((await req(app, '/session/org', cookie, {method: 'POST', headers: screen(2), body: JSON.stringify({orgId: 2})})).status, 200);
  // 今の組織を描いた画面からは、読み書きとも使える
  const ok = await read(await req(app, '/partners', cookie, {method: 'POST', headers: screen(1), body: JSON.stringify({code: 'PT-NEW', name: '架空の新規取引先', kind: 'other'})}));
  assert.equal(ok.status, 201);
  assert.equal((await db.get("SELECT org_id FROM partners WHERE code='PT-NEW'")).org_id, 1);
  assert.equal((await req(app, '/bootstrap', cookie, {headers: screen(1)})).status, 200);
  // 壊れたヘッダーも食い違いとして止める
  assert.equal((await req(app, '/bootstrap', cookie, {headers: {[ORG_HEADER]: 'abc'}})).status, 409);
});

// F1: 選んでいた組織の所属が失効・停止したら、既定の組織へ黙って戻して書き込んでいた
test('when the chosen org becomes invalid, only /api/session falls back (and clears the cookie); other requests get 409', async (t) => {
  const {db, app} = await fixture({t});
  await db.run("INSERT INTO memberships(org_id,user_id,role) VALUES(2,1,'admin')");
  const admin = await login(app);
  const toTwo = await switchOrg(app, admin, 2);
  assert.equal((await session(app, toTwo.cookie)).orgId, 2);
  await db.run("UPDATE memberships SET expires_at='2000-01-01T00:00:00.000Z' WHERE org_id=2 AND user_id=1");
  const partnersBefore = await count(db, 'SELECT count(*) AS n FROM partners');
  // 画面のヘッダーがあってもなくても、組織1には書き込まない
  for (const headers of [screen(2), {}]) {
    const write = await read(await req(app, '/partners', toTwo.cookie, {method: 'POST', headers, body: JSON.stringify({code: 'DEMO-X', name: '架空の取引先', kind: 'other'})}));
    assert.equal(write.status, 409, JSON.stringify(headers));
    assert.equal(write.body.code, ORG_MISMATCH_CODE);
  }
  assert.equal(await count(db, 'SELECT count(*) AS n FROM partners'), partnersBefore);
  assert.equal((await req(app, '/bootstrap', toTwo.cookie)).status, 409);
  // /api/session は既定（組織1）を返し、Cookie を消す。画面はこれで組織1を描き直す
  const current = await read(await req(app, '/session', toTwo.cookie));
  assert.equal(current.status, 200);
  assert.equal(current.body.user.orgId, 1);
  assert.equal(current.body.orgReset, true);
  assert.match(current.setCookie, /on_org=;/);
  assert.match(current.setCookie, /Max-Age=0/i);
  // Cookie が消えたあとは既定の組織で使える
  assert.deepEqual(await workIds(app, admin, screen(1)), [1]);
  assert.equal((await read(await req(app, '/session', admin))).body.orgReset, false);
  // 停止（active=0）でも同じ
  await db.run("UPDATE memberships SET expires_at=NULL, active=0 WHERE org_id=2 AND user_id=1");
  assert.equal((await req(app, '/works', toTwo.cookie)).status, 409);
  assert.equal((await switchOrg(app, admin, 2)).status, 403);
  // 所属していない組織を指す Cookie（本人の値の形）も同じ扱い。形が違う・別の利用者の値は無視して既定
  const editor = await login(app, 'editor@openingnight.invalid');
  assert.equal((await req(app, '/bootstrap', `${editor}; ${orgCookie(2, 2)}`)).status, 409);
  for (const value of ['2', '999', 'abc', '', encodeURIComponent('1:2')]) {
    const cookie = `${editor}; on_org=${value}`;
    const user = await session(app, cookie);
    assert.deepEqual({orgId: user.orgId, role: user.role}, {orgId: 1, role: 'editor'}, value);
    assert.deepEqual(await workIds(app, cookie), [1], value);
  }
  assert.equal((await req(app, '/downloads/publicity?workId=2', `${editor}; on_org=2`)).status, 403);
  // 所属が1つも有効でなければ認証できない
  await db.run('UPDATE memberships SET active=0 WHERE org_id=1 AND user_id=2');
  assert.equal((await req(app, '/session', editor)).status, 401);
});

test('the production role stays limited in its org; switching to another membership uses that role', async (t) => {
  const {db, app} = await fixture({t});
  await db.run("INSERT INTO memberships(org_id,user_id,role) VALUES(2,3,'editor')");
  await db.run("INSERT INTO project_memberships(org_id,project_id,user_id,permission) VALUES(2,2,3,'edit')");
  const production = await login(app, 'production@openingnight.invalid');
  assert.deepEqual(await session(app, production).then((user) => [user.orgId, user.role]), [1, 'production']);
  assert.equal((await req(app, '/expenses', production)).status, 403);
  assert.equal((await req(app, '/team', production)).status, 403);
  const boot = await read(await req(app, '/bootstrap', production));
  assert.equal('forecast_yen' in boot.body.works[0], false);

  const toTwo = await switchOrg(app, production, 2);
  assert.equal(toTwo.status, 200);
  assert.equal(toTwo.body.org.role, 'editor');
  assert.deepEqual(await session(app, toTwo.cookie).then((user) => [user.orgId, user.role]), [2, 'editor']);
  assert.equal((await req(app, '/expenses', toTwo.cookie)).status, 200);
  assert.equal((await read(await req(app, '/bootstrap', toTwo.cookie))).body.works[0].forecast_yen, 9999999);

  // 戻れば制作担当の制限に戻る。所属の無い組織へは切り替えられない
  const back = await switchOrg(app, toTwo.cookie, 1);
  assert.deepEqual(await session(app, back.cookie).then((user) => [user.orgId, user.role]), [1, 'production']);
  assert.equal((await req(app, '/expenses', back.cookie)).status, 403);
  await db.run("INSERT INTO organizations(id,code,name) VALUES(3,'third','第三の組織')");
  assert.equal((await switchOrg(app, back.cookie, 3)).status, 403);
  // 制作担当の Cookie を編集担当の組織（2）に書き換えても、所属の役割（editor）以上にはならない
  const forged = await session(app, `${production}; ${orgCookie(3, 2)}`);
  assert.equal(forged.role, 'editor');
});

test('logout clears the org choice so the next person starts in their default org', async (t) => {
  const {db, app} = await fixture({t});
  await db.run("INSERT INTO memberships(org_id,user_id,role) VALUES(2,1,'admin')");
  const admin = await login(app);
  const toTwo = await switchOrg(app, admin, 2);
  // 退出は画面の組織と食い違っていても受け付ける（前の組織を描いたタブからでも退出できる）
  const out = await read(await req(app, '/session', toTwo.cookie, {method: 'DELETE', headers: screen(1)}));
  assert.equal(out.status, 200);
  assert.match(out.setCookie, /on_org=;/);
  assert.match(out.setCookie, /Max-Age=0/i);
  // 退出したセッションは使えない
  assert.equal((await req(app, '/session', toTwo.cookie)).status, 401);
});

// F6: 退出せずにセッションが切れたあと、同じブラウザで入った次の人が、前の人の選んだ組織から始まっていた
test('logging in clears a leftover org choice, and another user never inherits it', async (t) => {
  const {db, app} = await fixture({t});
  await db.run("INSERT INTO memberships(org_id,user_id,role) VALUES(2,1,'admin')");
  await db.run("INSERT INTO memberships(org_id,user_id,role) VALUES(2,2,'editor')");
  const admin = await login(app);
  const toTwo = await switchOrg(app, admin, 2);
  const leftover = toTwo.cookie.split(/;\s*/).find((part) => part.startsWith(`${ORG_COOKIE}=`));
  assert.ok(leftover);
  // 同じブラウザ（on_org が残ったまま）で編集担当が入る
  const response = await app.request('/api/local/login', {method: 'POST', headers: {'content-type': 'application/json', cookie: leftover}, body: JSON.stringify({email: 'editor@openingnight.invalid'})});
  assert.equal(response.status, 200);
  const setCookie = response.headers.get('set-cookie');
  assert.match(setCookie, /on_session=/);
  assert.match(setCookie, /on_org=;/, 'ログインで前の人の組織の選択を消す');
  const editorSession = setCookie.split(';')[0];
  assert.ok(editorSession.startsWith('on_session='));
  assert.deepEqual(await session(app, `${editorSession}`).then((user) => [user.orgId, user.role]), [1, 'editor']);
  assert.equal((await db.get("SELECT org_id FROM sessions WHERE user_id=2")).org_id, 1);
  // Cookie が消えなかった場合（Worker で Access の利用者が替わった等）も、前の人（利用者1）の選択は使わない
  const inherited = await read(await req(app, '/session', `${editorSession}; ${leftover}`));
  assert.equal(inherited.body.user.orgId, 1);
  assert.equal(inherited.body.orgReset, false);
  assert.deepEqual(await workIds(app, `${editorSession}; ${leftover}`, screen(1)), [1]);
  // ログインの応答は、on_org が無ければ Cookie を1つだけ返す（従来どおり）
  const plain = await app.request('/api/local/login', {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify({email: 'editor@openingnight.invalid'})});
  assert.doesNotMatch(plain.headers.get('set-cookie'), /on_org/);
});

test('worker mode chooses the membership from the cookie after authentication and applies the same org check', async (t) => {
  // Worker（worker.mjs・cloud-worker.mjs）は JWT を確かめたあと identityForEmail で所属を選ぶ。ここでは JWT の検証済みとして同じ関数を呼ぶ
  const db = await openTestDb({t});
  let email = 'admin@openingnight.invalid';
  const app = createApp({db, mode: 'worker', authenticate: (request, database) => identityForEmail(database, email, request.headers.get('cookie'))});
  await db.run("INSERT INTO memberships(org_id,user_id,role) VALUES(2,1,'admin')");
  await db.run("INSERT INTO memberships(org_id,user_id,role) VALUES(2,2,'editor')");
  assert.equal((await session(app, 'CF_Authorization=jwt')).orgId, 1);
  const toTwo = await switchOrg(app, 'CF_Authorization=jwt', 2, 'https://integrated.example/api/session/org');
  assert.equal(toTwo.status, 200);
  assert.match(toTwo.setCookie, /Secure/);
  assert.equal((await session(app, toTwo.cookie)).orgId, 2);
  assert.deepEqual(await workIds(app, toTwo.cookie, screen(2)), [2]);
  // 前の組織（1）を描いた画面からの書き込みは 409
  const stale = await read(await req(app, '/partners', toTwo.cookie, {method: 'POST', headers: screen(1), body: JSON.stringify({code: 'DEMO-W', name: '架空', kind: 'other'})}));
  assert.equal(stale.status, 409);
  assert.equal(stale.body.code, ORG_MISMATCH_CODE);
  assert.equal((await switchOrg(app, 'CF_Authorization=jwt', 5)).status, 403);
  // Access の利用者が替わっても（同じブラウザ）、前の人の選択は使わない
  email = 'editor@openingnight.invalid';
  assert.deepEqual(await session(app, toTwo.cookie).then((user) => [user.orgId, user.role]), [1, 'editor']);
  email = 'admin@openingnight.invalid';
  await db.run('UPDATE memberships SET active=0 WHERE org_id=2 AND user_id=1');
  assert.equal((await req(app, '/bootstrap', toTwo.cookie)).status, 409);
  assert.equal((await session(app, toTwo.cookie)).orgId, 1);
});

// F5: 切替の記録を audit_log に入れていたので、組織1へ戻るだけで分析が「業務データが更新された」と表示された
test('switching org does not move the audit_log high-water mark that analytics uses for staleness', async (t) => {
  const {db, app} = await fixture({t});
  await db.run("INSERT INTO memberships(org_id,user_id,role) VALUES(2,1,'admin')");
  const admin = await login(app);
  // 業務データの変更を1件入れておく（分析版はここまでを見たとする）
  assert.equal((await req(app, '/settings/fiscal', admin, {method: 'PUT', headers: screen(1), body: JSON.stringify({fiscalStartMonth: 4})})).status, 200);
  const through = (await db.get('SELECT COALESCE(MAX(id),0) AS id FROM audit_log WHERE org_id=1')).id;
  assert.ok(through > 0);
  const toTwo = await switchOrg(app, admin, 2);
  const back = await switchOrg(app, toTwo.cookie, 1);
  assert.equal(back.status, 200);
  assert.equal((await db.get('SELECT COALESCE(MAX(id),0) AS id FROM audit_log WHERE org_id=1')).id, through, '組織1の業務データの記録は増えない');
  assert.equal((await db.get('SELECT COALESCE(MAX(id),0) AS id FROM audit_log WHERE org_id=2')).id, 0);
  assert.deepEqual((await db.all('SELECT org_id,user_id,from_org_id FROM org_switch_events ORDER BY id')).map((row) => ({...row})), [{org_id: 2, user_id: 1, from_org_id: 1}, {org_id: 1, user_id: 1, from_org_id: 2}]);
  // 記録は追加だけ（変更・削除できない）。所属の無い組織・同じ組織の組は入れられない
  await assert.rejects(db.run('UPDATE org_switch_events SET from_org_id=1 WHERE id=2'), (e) => e.dbError?.kind === 'raise' && /変更できません/.test(e.message));
  await assert.rejects(db.run('DELETE FROM org_switch_events'), (e) => e.dbError?.kind === 'raise' && /削除できません/.test(e.message));
  await assert.rejects(db.run('INSERT INTO org_switch_events(org_id,user_id,from_org_id) VALUES(2,2,1)'), (e) => e.dbError?.kind === 'foreign_key');
  await assert.rejects(db.run('INSERT INTO org_switch_events(org_id,user_id,from_org_id) VALUES(1,1,1)'), (e) => e.dbError?.kind === 'check');
});
