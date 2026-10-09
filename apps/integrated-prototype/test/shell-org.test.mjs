// 画面側の組織まわり（shell/org-model.mjs・ui/api-client.mjs・shell/OrgSelector.jsx・main.jsx の配線）。
// F1: 画面が描いている組織を毎回の要求に載せ、食い違いの 409 で今の組織に読み直す
// F2: 組織の切替のあと読み直しに失敗したら、前の組織の画面とデータを残さない。所属の一覧だけの失敗は選択欄を消さずに知らせる
// F3: Worker の退出は Cloudflare Access のサインアウトへ。ローカルのログイン画面はローカルでだけ出す
// F7: 選択欄で選ぶだけでは切り替えず「切り替える」で実行する。役割は「・」で区切る
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync, writeFileSync, mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
import {openTestDb} from './test-db.mjs';
import {createApp} from '../src/app.mjs';
import {ApiError, createApi, isOrgMismatch, ORG_HEADER, ORG_MISMATCH_CODE} from '../src/ui/api-client.mjs';
import {
  ACCESS_LOGOUT_PATH, ORG_LOAD_FAILED_TITLE, ORG_LIST_FAILED_MESSAGE, ROLE_LABELS, loadFailurePlan, loadSessionData, logoutDestination,
  openOrgChannel, orgNameOf, orgOptionLabel, orgSwitchTarget, orgSyncedNotice, usesLocalLogin,
} from '../src/shell/org-model.mjs';

const appDir = fileURLToPath(new URL('..', import.meta.url));
const json = (status, body) => new Response(JSON.stringify(body), {status, headers: {'content-type': 'application/json; charset=utf-8'}});

// ブラウザ1つ（Cookie は全タブで共有）を、app.request の上に作る。記録した要求のヘッダーも返す
function browser(app, initialCookie = '') {
  const jar = new Map(initialCookie.split(/;\s*/).filter(Boolean).map((part) => part.split('=')).map(([name, ...rest]) => [name, rest.join('=')]));
  const log = [];
  const fetchImpl = async (url, init = {}) => {
    const cookie = [...jar].map(([name, value]) => `${name}=${value}`).join('; ');
    log.push({url, method: init.method || 'GET', headers: {...init.headers}});
    const response = await app.request(url, {...init, headers: {...init.headers, cookie}});
    for (const part of (response.headers.get('set-cookie') || '').split(/,\s*(?=[a-z_]+=)/i)) {
      const [pair, ...attrs] = part.split(';');
      if (!pair) continue;
      const [name, ...rest] = pair.trim().split('=');
      if (attrs.some((attr) => /max-age=0/i.test(attr))) jar.delete(name);
      else jar.set(name, rest.join('='));
    }
    return response;
  };
  return {fetchImpl, log, jar};
}

test('api client sends the rendered org in X-On-Org, lets a request override it, and reports org mismatches once', async () => {
  const calls = [];
  const mismatches = [];
  let rendered = 2;
  let reply = () => json(200, {ok: true});
  const request = createApi({fetchImpl: async (url, init) => { calls.push(init.headers); return reply(); }, orgId: () => rendered, onOrgMismatch: (error) => mismatches.push(error)});
  await request('/works');
  await request('/session', {orgId: null});
  await request('/bootstrap', {orgId: 5});
  rendered = null;
  await request('/works');
  rendered = 'abc';
  await request('/works');
  assert.deepEqual(calls.map((headers) => headers[ORG_HEADER] ?? null), ['2', null, '5', null, null]);
  assert.equal(ORG_HEADER, 'X-On-Org');
  // 組織の食い違いの 409 は code を持ち、onOrgMismatch を呼んでから投げる
  rendered = 2;
  reply = () => json(409, {ok: false, error: '別の画面で組織が切り替わりました。今の組織で読み直してください', code: ORG_MISMATCH_CODE, currentOrgId: 1});
  await assert.rejects(request('/partners', {method: 'POST', body: {code: 'X'}}), (error) => error instanceof ApiError && error.status === 409 && error.kind === 'conflict' && error.code === ORG_MISMATCH_CODE && isOrgMismatch(error));
  assert.equal(mismatches.length, 1);
  // 読み直しの途中の要求（notifyOrgMismatch:false）と、ほかの 409 は知らせない
  await assert.rejects(request('/bootstrap', {notifyOrgMismatch: false}), (error) => isOrgMismatch(error));
  reply = () => json(409, {ok: false, error: '他の人が先に更新しました'});
  await assert.rejects(request('/works', {method: 'PUT', body: {}}), (error) => error.status === 409 && error.code === null && !isOrgMismatch(error));
  assert.equal(mismatches.length, 1);
  // 通知の関数が失敗しても、要求の誤りはそのまま投げる
  const throwing = createApi({fetchImpl: async () => json(409, {ok: false, error: 'x', code: ORG_MISMATCH_CODE}), orgId: () => 1, onOrgMismatch: () => { throw new Error('boom'); }});
  await assert.rejects(throwing('/works'), (error) => isOrgMismatch(error));
});

// F1 の画面側: 別のタブで切り替えたあと、前の組織を描いたタブの保存は止まり、今の組織で読み直せる
test('a stale tab is stopped by 409, then loadSessionData reloads it into the org the server now uses', async (t) => {
  const db = await openTestDb({t});
  try {
    const app = createApp({db, mode: 'local'});
    await db.run("INSERT INTO memberships(org_id,user_id,role) VALUES(2,1,'admin')");
    const login = await app.request('/api/local/login', {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify({email: 'admin@openingnight.invalid'})});
    const b = browser(app, login.headers.get('set-cookie').split(';')[0]);
    const tabA = {orgId: 1}, tabB = {orgId: 1}, mismatches = [];
    const apiA = createApi({fetchImpl: b.fetchImpl, orgId: () => tabA.orgId});
    const apiB = createApi({fetchImpl: b.fetchImpl, orgId: () => tabB.orgId, onOrgMismatch: (error) => mismatches.push(error)});
    // タブB は組織2を開いて描く
    await apiB('/session/org', {method: 'POST', body: {orgId: 2}, orgId: null});
    const loadedB = await loadSessionData(apiB);
    tabB.orgId = loadedB.session.orgId;
    assert.equal(tabB.orgId, 2);
    assert.deepEqual(loadedB.bootstrap.works.map((work) => work.id), [2]);
    // タブA で組織1へ戻す（Cookie はブラウザで1つ）
    await apiA('/session/org', {method: 'POST', body: {orgId: 1}, orgId: null});
    const partners = Number((await db.get('SELECT count(*) AS n FROM partners')).n);
    await assert.rejects(apiB('/partners', {method: 'POST', body: {code: 'DEMO-X', name: '架空の取引先', kind: 'other'}}), (error) => isOrgMismatch(error) && error.body.currentOrgId === 1);
    assert.equal(mismatches.length, 1, 'タブB は読み直しを始める');
    assert.equal(Number((await db.get('SELECT count(*) AS n FROM partners')).n), partners, '組織1に書き込まない');
    // タブB の読み直し: /api/session（照合しない）で組織1を知り、組織1を載せて読む
    b.log.length = 0;
    const reloaded = await loadSessionData(apiB);
    assert.equal(reloaded.session.orgId, 1);
    assert.deepEqual(reloaded.bootstrap.works.map((work) => work.id), [1]);
    assert.equal(orgNameOf(reloaded), 'オープニングナイト試作チーム');
    assert.deepEqual(b.log.map((entry) => [entry.url, entry.headers[ORG_HEADER] ?? null]), [
      ['/api/session', null], ['/api/bootstrap', '1'], ['/api/workflow/capabilities', '1'], ['/api/session/orgs', '1'],
    ]);
    tabB.orgId = reloaded.session.orgId;
    const saved = await apiB('/partners', {method: 'POST', body: {code: 'PT-B', name: '架空の取引先B', kind: 'other'}});
    assert.equal(saved.ok, true);
    assert.equal((await db.get("SELECT org_id FROM partners WHERE code='PT-B'")).org_id, 1);
    assert.equal(mismatches.length, 1);
  } finally { await db.close(); }
});

test('loadSessionData re-checks the org when it changes mid-load, and gives up after the attempts', async () => {
  const mismatch = () => new ApiError('食い違い', {status: 409, kind: 'conflict', code: ORG_MISMATCH_CODE, body: {code: ORG_MISMATCH_CODE}});
  const orgs = [2, 1];
  const seen = [];
  const request = async (path, options = {}) => {
    seen.push([path, options.orgId ?? null, options.notifyOrgMismatch]);
    if (path === '/session') return {ok: true, user: {orgId: orgs[0]}, mode: 'worker', orgReset: orgs.length === 2};
    if (path === '/bootstrap' && options.orgId !== orgs[0]) throw mismatch();
    if (path === '/bootstrap' && orgs.length === 2) { orgs.shift(); throw mismatch(); }
    if (path === '/bootstrap') return {works: [{id: 1}]};
    if (path === '/workflow/capabilities') return {ok: true, extractionEnabled: false, mappingAiEnabled: true};
    if (path === '/session/orgs') return {ok: true, orgs: [{id: 1, name: '組織1'}, {id: 2, name: '組織2'}]};
    throw new Error(path);
  };
  const loaded = await loadSessionData(request);
  assert.equal(loaded.session.orgId, 1);
  assert.equal(loaded.mode, 'worker');
  assert.equal(loaded.orgReset, true, '1回目の /api/session で既定へ戻したことを覚えておく');
  assert.deepEqual(loaded.capabilities, {ok: true, extractionEnabled: false, mappingAiEnabled: true});
  assert.ok(seen.every(([, , notify]) => notify === false), '読み直しの途中の要求では onOrgMismatch を呼ばない');
  assert.equal(seen.filter(([path]) => path === '/session').length, 2);
  const always = async (path) => { if (path === '/session') return {user: {orgId: 1}}; throw mismatch(); };
  await assert.rejects(loadSessionData(always, {attempts: 2}), (error) => isOrgMismatch(error));
  const broken = async (path) => { if (path === '/session') return {user: {orgId: 1}}; throw new ApiError('障害', {status: 500, kind: 'server'}); };
  await assert.rejects(loadSessionData(broken), (error) => error.kind === 'server');
});

// F2: /api/session/orgs が失敗しても、ほかは使えるようにし、一覧は「前のまま」（null）と誤りを返す
test('loadSessionData keeps going when only the org list fails, and reports it instead of an empty list', async () => {
  const listError = new ApiError('一覧の障害', {status: 500, kind: 'server'});
  const request = async (path) => {
    if (path === '/session') return {user: {orgId: 1}, mode: 'local'};
    if (path === '/bootstrap') return {works: []};
    if (path === '/workflow/capabilities') return {ok: true};
    throw listError;
  };
  const loaded = await loadSessionData(request);
  assert.equal(loaded.orgs, null, '空の一覧で選択欄を消さない');
  assert.equal(loaded.orgsError, listError);
  assert.equal(ORG_LIST_FAILED_MESSAGE, '組織の一覧を読み込めませんでした');
});

// F2: 組織が変わる読み直しの失敗は、前の組織の画面とデータを捨てる（discard）。同じ組織の読み直しの失敗は画面に出す（notice）
test('loadFailurePlan discards the previous org on a failed org transition and shows other failures', () => {
  const server = new ApiError('障害', {status: 500, kind: 'server'});
  const auth = new ApiError('切れ', {status: 401, kind: 'auth'});
  const mismatch = new ApiError('食い違い', {status: 409, kind: 'conflict', code: ORG_MISMATCH_CODE});
  assert.equal(loadFailurePlan({error: auth, orgTransition: true, rendered: true}), 'signed-out');
  assert.equal(loadFailurePlan({error: server, orgTransition: true, rendered: true}), 'discard');
  assert.equal(loadFailurePlan({error: mismatch, orgTransition: false, rendered: true}), 'discard');
  assert.equal(loadFailurePlan({error: server, orgTransition: false, rendered: true}), 'notice');
  assert.equal(loadFailurePlan({error: server, orgTransition: false, rendered: false}), 'fatal');
  assert.match(ORG_LOAD_FAILED_TITLE, /組織は切り替わりましたが、読み込めませんでした/);
  assert.equal(orgSyncedNotice({orgName: '架空データ（デモ）'}), '別の画面で組織が切り替わったため、この画面を「架空データ（デモ）」で開き直しました。');
  assert.match(orgSyncedNotice({orgName: '組織1', reset: true, rejected: true}), /^選んでいた組織の所属が無効になったため、「組織1」で開き直しました。直前の操作は行っていません/);
  assert.equal(orgNameOf({session: {orgId: 3}, orgs: null}), '');
});

// F3: Worker の退出は Access のサインアウトへ。ローカルのログイン画面はローカルでだけ
test('logout goes to Cloudflare Access sign-out outside local mode, and only local mode uses the local login form', () => {
  assert.equal(ACCESS_LOGOUT_PATH, '/cdn-cgi/access/logout');
  assert.equal(logoutDestination('worker'), ACCESS_LOGOUT_PATH);
  assert.equal(logoutDestination('unknown'), ACCESS_LOGOUT_PATH);
  assert.equal(logoutDestination(null), ACCESS_LOGOUT_PATH);
  assert.equal(logoutDestination('local'), null);
  assert.equal(usesLocalLogin('local'), true);
  assert.equal(usesLocalLogin('worker'), false);
  // main.jsx の配線（DOM の試験環境が無いため、画面の分かれ目だけを確かめる）
  const main = readFileSync(new URL('../src/main.jsx', import.meta.url), 'utf8');
  assert.match(main, /usesLocalLogin\(mode\) \? <Login onLogin=\{reload\} \/> : <SignedOut \/>/);
  assert.match(main, /const destination = logoutDestination\(mode\);\s*if \(destination\) \{\s*window\.location\.assign\(destination\);\s*return;/);
  assert.doesNotMatch(main, /if \(!session\) return <Login/);
  // 組織の切替・食い違いの読み直しの失敗は前の組織の画面を捨てる（refreshAll の discard）
  assert.match(main, /plan === "discard"\) \{\s*orgContext\.renderedOrgId = null;\s*setBootstrap\(null\);\s*setLoadError\(\{ error, title: ORG_LOAD_FAILED_TITLE \}\);/);
  assert.match(main, /createApi\(\{ orgId: \(\) => orgContext\.renderedOrgId, onOrgMismatch:/);
});

test('the Worker DELETE /api/session clears the org choice (the page then signs out of Access)', async (t) => {
  const db = await openTestDb({t});
  try {
    const {identityForEmail} = await import('../src/session-org.mjs');
    const app = createApp({db, mode: 'worker', authenticate: (request, database) => identityForEmail(database, 'admin@openingnight.invalid', request.headers.get('cookie'))});
    const response = await app.request('/api/session', {method: 'DELETE', headers: {cookie: 'on_org=1%3A1'}});
    assert.equal(response.status, 200);
    assert.match(response.headers.get('set-cookie'), /on_org=;.*Max-Age=0/i);
    // ローカルのログインは Worker では使えない（画面はこのログイン画面を出さない）
    assert.equal((await app.request('/api/local/login', {method: 'POST', headers: {'content-type': 'application/json'}, body: '{}'})).status, 404);
    assert.equal((await (await app.request('/api/session')).json()).mode, 'worker');
  } finally { await db.close(); }
});

// F7: 選択肢の表示と、選んだだけでは切り替えないこと
test('org options separate the role with a middle dot, and only a different valid org can be applied', () => {
  assert.equal(orgOptionLabel({id: 3, name: '架空データ（デモ）', role: 'admin'}), '架空データ（デモ）・管理者');
  assert.equal(orgOptionLabel({id: 1, name: 'オープニングナイト試作チーム', role: 'production'}), 'オープニングナイト試作チーム・制作担当');
  assert.equal(orgOptionLabel({id: 4, name: '', role: 'owner'}), '組織 4・役割未確認');
  assert.deepEqual(ROLE_LABELS, {admin: '管理者', editor: '編集担当', production: '制作担当'});
  assert.equal(orgSwitchTarget('3', 1), 3);
  assert.equal(orgSwitchTarget('1', 1), null, '今の組織は選べない');
  assert.equal(orgSwitchTarget('', 1), null);
  assert.equal(orgSwitchTarget('abc', 1), null);
  assert.equal(orgSwitchTarget('0', 1), null);
});

// OrgSelector を実際に描いて確かめる（JSX は esbuild で変換する。DOM は使わず文字列に描く）
async function renderOrgSelector() {
  const {build} = await import('esbuild');
  const result = await build({
    stdin: {
      contents: "import React from 'react'; import {renderToStaticMarkup} from 'react-dom/server'; import {OrgSelector} from './src/shell/OrgSelector.jsx';\nexport const render = (props) => renderToStaticMarkup(React.createElement(OrgSelector, props));",
      resolveDir: appDir, loader: 'jsx', sourcefile: 'org-selector-entry.jsx',
    },
    bundle: true, platform: 'node', format: 'cjs', write: false, jsx: 'automatic', logLevel: 'silent',
  });
  const dir = mkdtempSync(join(tmpdir(), 'on-org-selector-'));
  const file = join(dir, 'org-selector.cjs');
  writeFileSync(file, result.outputFiles[0].text);
  try { return createRequire(import.meta.url)(file).render; } finally { rmSync(dir, {recursive: true, force: true}); }
}

test('OrgSelector renders a select plus a separate submit button, and shows a list failure without hiding the retry', async () => {
  const render = await renderOrgSelector();
  const orgs = [{id: 1, name: 'オープニングナイト試作チーム', role: 'admin'}, {id: 3, name: '架空データ（デモ）', role: 'admin'}];
  const html = render({orgs, currentOrgId: 1, onSwitch: async () => true});
  assert.match(html, /<form class="app-org">/);
  assert.match(html, /<option value="3">架空データ（デモ）・管理者<\/option>/);
  assert.doesNotMatch(html, /（管理者）/);
  // 今の組織が選ばれている間は「切り替える」を押せない（選択欄の change では切り替えない）
  assert.match(html, /<button type="submit" class="secondary app-org-apply" disabled="">切り替える<\/button>/);
  const busy = render({orgs, currentOrgId: 1, onSwitch: async () => true, busy: true});
  assert.match(busy, /<select disabled="">/);
  assert.match(busy, /切り替えています…/);
  // 所属が1つなら何も描かない
  assert.equal(render({orgs: orgs.slice(0, 1), currentOrgId: 1, onSwitch: async () => true}), '');
  // 一覧が読めなかったときは、所属が分からなくても誤りと再試行を出す（選択欄を黙って消さない）
  const failed = render({orgs: [], currentOrgId: 1, onSwitch: async () => true, listError: new Error('x'), onRetryList: () => {}});
  assert.match(failed, /role="alert">組織の一覧を読み込めませんでした<button type="button" class="text">再試行<\/button>/);
  const failedWithList = render({orgs, currentOrgId: 1, onSwitch: async () => true, listError: new Error('x'), onRetryList: () => {}});
  assert.match(failedWithList, /<select/);
  assert.match(failedWithList, /組織の一覧を読み込めませんでした/);
});

test('openOrgChannel tells other tabs about a switch but not the tab that sent it', () => {
  const instances = [];
  class FakeChannel {
    constructor(name) { this.name = name; this.closed = false; instances.push(this); }
    postMessage(data) { for (const other of instances) if (other !== this && !other.closed && other.name === this.name) other.onmessage?.({data}); }
    close() { this.closed = true; }
  }
  const seenA = [], seenB = [];
  const tabA = openOrgChannel((orgId) => seenA.push(orgId), FakeChannel);
  const tabB = openOrgChannel((orgId) => seenB.push(orgId), FakeChannel);
  tabA.post(3);
  assert.deepEqual(seenA, []);
  assert.deepEqual(seenB, [3]);
  instances[1].onmessage({data: {orgId: 'x'}});
  assert.deepEqual(seenB, [3], '不正な値は無視する');
  tabB.close();
  tabA.post(1);
  assert.deepEqual(seenB, [3]);
  assert.equal(openOrgChannel(() => {}, null), null, 'BroadcastChannel の無い環境では null');
});
