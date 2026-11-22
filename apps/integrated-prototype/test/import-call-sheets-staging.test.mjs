// scripts/import-call-sheets.mjs の staging 版と検査だけ（--check-only）。トークンは架空。外へは送らない（fetch を差し替える）。
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createStagingClient, runWithoutLocalDb, parseArgs} from '../scripts/import-call-sheets.mjs';
import {STAGING_ORIGIN, accessHeaders, selectOrgCookie} from '../scripts/staging-access.mjs';

const ID = '0123456789abcdef0123456789abcdef.access';
const SECRET = 'fictional-secret-value';
const token = {id: ID, secret: SECRET};
const env = {ON_STAGING_ACCESS_ID: ID, ON_STAGING_ACCESS_SECRET: SECRET};
const demoPath = fileURLToPath(new URL('../demo-fixtures/call-sheets/call-sheets-demo.json', import.meta.url));
const json = (body, status = 200) => new Response(JSON.stringify(body), {status, headers: {'content-type': 'application/json'}});

test('staging の client は /api の下だけを呼び、トークンを見出しにだけ載せ、書き込みには Origin を付け、転送を追わない', async () => {
  const seen = [];
  const call = createStagingClient({token, fetchImpl: async (url, init) => { seen.push({url, init}); return json({ok: true, rows: []}); }});
  await call('GET', '/production?workId=7');
  await call('PATCH', '/scenes/3', {synopsis: '架空'}, {'if-match': '2'});
  assert.equal(seen[0].url, `${STAGING_ORIGIN}/api/production?workId=7`);
  assert.equal(seen[0].init.headers['CF-Access-Client-Id'], ID);
  assert.equal(seen[0].init.headers['CF-Access-Client-Secret'], SECRET);
  assert.equal(seen[0].init.headers.origin, undefined);
  assert.equal(seen[0].init.redirect, 'manual');
  assert.equal(seen[1].init.headers.origin, STAGING_ORIGIN);
  assert.equal(seen[1].init.headers['if-match'], '2');
  assert.equal(seen[1].init.headers['content-type'], 'application/json');
  for (const {url, init} of seen) assert.ok(!url.includes(SECRET) && !String(init.body ?? '').includes(SECRET));
  // 呼ぶ側の見出しでトークンを差し替えられない
  await call('GET', '/works', undefined, {'CF-Access-Client-Secret': 'other'});
  assert.equal(seen[2].init.headers['CF-Access-Client-Secret'], SECRET);
  await assert.rejects(call('GET', '/../x'), /\/api\//);
  assert.throws(() => accessHeaders({id: ID, secret: ''}));
});

test('staging の client は転送・エラーで投げ、文にトークンの値を入れない', async () => {
  const redirect = createStagingClient({token, fetchImpl: async () => new Response(null, {status: 302, headers: {location: 'https://example.invalid/login'}})});
  await assert.rejects(redirect('GET', '/works'), /302（Access のログイン画面/);
  const echo = createStagingClient({token, fetchImpl: async () => json({ok: false, error: `bad ${SECRET} ${ID}`}, 400)});
  await assert.rejects(echo('POST', '/scenes', {}), (error) => { assert.ok(!error.message.includes(SECRET) && !error.message.includes(ID), error.message); return true; });
  const html = createStagingClient({token, fetchImpl: async () => new Response('<html></html>', {status: 200})});
  await assert.rejects(html('GET', '/works'), /JSON でない応答/);
});

test('引数: staging は --work-id・--source・--files が要り、--db と混ぜない。既定は今までどおり --db', () => {
  assert.equal(parseArgs(['--db', 'a.sqlite', '--source', 's.json', '--files', 'pdf']).mode, 'db');
  assert.equal(parseArgs(['--staging', '--work-id', '12', '--source', 's.json', '--files', 'pdf']).workId, 12);
  assert.equal(parseArgs(['--check-only', '--source', 's.json']).mode, 'check');
  for (const argv of [['--staging', '--source', 's.json', '--files', 'pdf'], ['--staging', '--work-id', '0', '--source', 's.json', '--files', 'pdf'],
    ['--staging', '--work-id', '1', '--source', 's.json', '--files', 'pdf', '--db', 'a.sqlite'], ['--source', 's.json', '--files', 'pdf'],
    ['--db', 'a.sqlite', '--work-id', '1', '--source', 's.json', '--files', 'pdf'], ['--staging', '--work-id', '1', '--source', 's.json'], ['--dry-run', '--source', 's.json']])
    assert.throws(() => parseArgs(argv), undefined, argv.join(' '));
});

test('runWithoutLocalDb: --check-only は受け口を呼ばずに検査だけ。問題があれば 1、PDF が無ければ 1', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'call-sheet-check-'));
  t.after(() => rm(dir, {recursive: true, force: true}));
  const out = [], err = [];
  const io = {env: {}, fetchImpl: async () => { throw new Error('呼ばない'); }, stdout: (l) => out.push(l), stderr: (l) => err.push(l)};
  assert.equal((await runWithoutLocalDb(['--check-only', '--source', demoPath], io)).code, 0);
  assert.equal((await runWithoutLocalDb(['--check-only', '--source', demoPath, '--files', dir], io)).code, 1);
  assert.match(err.at(-1), /PDF が見つかりません: day1-draft\.pdf/);
  const bad = join(dir, 'bad.json');
  const source = JSON.parse(await (await import('node:fs/promises')).readFile(demoPath, 'utf8'));
  source.sheets[0].weekday = '日';
  await writeFile(bad, JSON.stringify(source));
  assert.equal((await runWithoutLocalDb(['--check-only', '--source', bad], io)).code, 1);
  assert.ok(err.some((l) => l.includes('day1-draft.pdf weekday')));
  // staging でも、問題のある JSON はトークンを見る前・受け口を呼ぶ前に止まる
  assert.equal((await runWithoutLocalDb(['--staging', '--work-id', '1', '--source', bad, '--files', dir], {...io, env})).code, 1);
});

test('runWithoutLocalDb: staging は作品を確かめてから取り込み、トークンの値を出力しない。トークンが無ければ 2', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'call-sheet-staging-'));
  t.after(() => rm(dir, {recursive: true, force: true}));
  for (const name of ['day1-draft.pdf', 'day1-final.pdf', 'day2-draft.pdf']) await writeFile(join(dir, name), `%PDF-1.4 架空 ${name}`);
  const out = [], err = [], requests = [];
  const io = {stdout: (l) => out.push(l), stderr: (l) => err.push(l)};
  assert.equal((await runWithoutLocalDb(['--staging', '--work-id', '7', '--source', demoPath, '--files', dir], {...io, env: {}, fetchImpl: async () => { throw new Error('呼ばない'); }})).code, 2);

  // 作品が無ければ止まる（取り込みの書き込みは呼ばない）
  const fetchImpl = async (url, init) => {
    requests.push(`${init.method} ${url.slice(STAGING_ORIGIN.length)}`);
    if (url.endsWith('/api/works')) return json({ok: true, rows: [{id: 7, project_id: 3}]});
    if (url.includes('/documents') && init.method === 'GET') return json({ok: true, documents: []});
    return json({ok: false, error: `受け口の架空のエラー ${SECRET}`}, 409);
  };
  assert.equal((await runWithoutLocalDb(['--staging', '--work-id', '8', '--source', demoPath, '--files', dir], {...io, env, fetchImpl})).code, 1);
  assert.deepEqual(requests, ['GET /api/works']);
  assert.match(err.at(-1), /作品 8 がありません/);

  // 受け口がエラーを返せば 1 で止まり、トークンの値は出ない
  requests.length = 0;
  assert.equal((await runWithoutLocalDb(['--staging', '--work-id', '7', '--source', demoPath, '--files', dir], {...io, env, fetchImpl})).code, 1);
  assert.deepEqual(requests.slice(0, 3), ['GET /api/works', 'GET /api/preprod/works/7/documents', 'GET /api/preprod/works/7/documents']);
  for (const line of [...out, ...err]) assert.ok(!line.includes(SECRET) && !line.includes(ID), line);
});

test('--org: 組織を選べたときだけ Cookie を付けて呼び、選べなければ投げて何も送らない', async () => {
  assert.equal(parseArgs(['--staging', '--work-id', '12', '--org', '7', '--source', 's.json', '--files', 'pdf']).org, 7);
  for (const argv of [['--staging', '--work-id', '12', '--org', '0', '--source', 's.json', '--files', 'pdf'],
    ['--db', 'a.sqlite', '--org', '7', '--source', 's.json', '--files', 'pdf']])
    assert.throws(() => parseArgs(argv), undefined, argv.join(' '));
  // 架空の staging: 利用者 5 は組織 1（既定）と 7 に所属。所属していない組織の Cookie は既定の組織へ戻す
  const seen = [];
  const fetchImpl = async (url, init) => {
    seen.push({path: new URL(url).pathname, method: init.method, cookie: init.headers.cookie ?? null});
    const chosen = /^on_org=5:(\d+)$/.exec(init.headers.cookie ?? '')?.[1];
    return json({ok: true, user: {id: 5, orgId: chosen && ['1', '7'].includes(chosen) ? Number(chosen) : 1}, rows: []});
  };
  const cookie = await selectOrgCookie({token, orgId: 7, fetchImpl});
  assert.equal(cookie, 'on_org=5:7');
  await createStagingClient({token, fetchImpl, orgCookie: cookie})('POST', '/works', {});
  assert.deepEqual(seen.at(-1), {path: '/api/works', method: 'POST', cookie: 'on_org=5:7'});
  seen.length = 0;
  await assert.rejects(selectOrgCookie({token, orgId: 9, fetchImpl}), /組織 9 を選べなかった/);
  assert.ok(seen.every((c) => c.path === '/api/session' && c.method === 'GET'), '選べなければ確かめの GET だけで、書き込みは送らない');
});
