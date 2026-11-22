// scripts/staging-api.mjs（サービストークンで staging の受け口を呼ぶ道具）。値は架空。外へは送らない（fetch を差し替える）。
import test from 'node:test';
import assert from 'node:assert/strict';
import {parseArgs, buildRequest, main, STAGING_ORIGIN} from '../scripts/staging-api.mjs';

const ID = '0123456789abcdef0123456789abcdef.access';
const SECRET = 'fictional-secret-value';

test('呼べるのは /api/ の下だけで、GET に本文を付けず、--body と --manifest を一緒に使わない', () => {
  assert.deepEqual(parseArgs(['GET', '/api/session']), {method: 'GET', path: '/api/session', body: null, manifest: null, apply: false, out: null, org: null});
  for (const argv of [['DELETE', '/api/x'], ['GET', '/'], ['GET', 'https://example.invalid/api/x'], ['GET', '/api/../x'], ['GET', '/api/x y'],
    ['GET', '/api/x', '--body', 'a.json'], ['POST', '/api/x', '--body', 'a', '--manifest', 'b'], ['POST', '/api/x', '--nope', 'v'], ['GET', '/api/x', '--org', '0'], ['GET', '/api/x', '--org', 'ORG'], ['GET', '/api/x', '--org']])
    assert.throws(() => parseArgs(argv), undefined, argv.join(' '));
});

test('目録は {manifest, dryRun} にし、--apply が無ければ dryRun。トークンは見出しにだけ載せる', () => {
  const tsv = '﻿key\tsize\tsha256\tuploaded_at\ncurrent/a.pdf\t1\t' + 'a'.repeat(64) + '\t2026-11-06T00:00:00+09:00\n';
  const dry = buildRequest(parseArgs(['POST', '/api/source-documents/import-r2-manifest', '--manifest', 'm.tsv']), {id: ID, secret: SECRET, readText: () => tsv});
  assert.equal(dry.url, `${STAGING_ORIGIN}/api/source-documents/import-r2-manifest`);
  assert.deepEqual(JSON.parse(dry.init.body), {manifest: tsv.slice(1), dryRun: true});
  assert.equal(dry.init.headers['CF-Access-Client-Id'], ID);
  assert.equal(dry.init.headers['CF-Access-Client-Secret'], SECRET);
  assert.equal(dry.init.redirect, 'manual', 'ログイン画面への転送を追わない');
  assert.equal(dry.init.headers.origin, STAGING_ORIGIN, '書き込みは Worker の Origin の確かめを通す');
  assert.equal(buildRequest(parseArgs(['GET', '/api/session']), {id: ID, secret: SECRET}).init.headers.origin, undefined, '読むだけなら Origin を付けない');
  assert.ok(!dry.url.includes(SECRET) && !dry.init.body.includes(SECRET));
  const apply = buildRequest(parseArgs(['POST', '/api/source-documents/import-r2-manifest', '--manifest', 'm.tsv', '--apply']), {id: ID, secret: SECRET, readText: () => tsv});
  assert.equal(JSON.parse(apply.init.body).dryRun, false);
  assert.throws(() => buildRequest(parseArgs(['GET', '/api/session']), {id: '', secret: SECRET}));
});

test('main はトークンの値を出力せず、2xx で 0・エラーで 2・転送で 2・使い方の誤りで 1 を返す', async () => {
  const out = []; const err = [];
  const env = {ON_STAGING_ACCESS_ID: ID, ON_STAGING_ACCESS_SECRET: SECRET};
  const respond = (status, text = '{"ok":true}') => async () => new Response(status >= 300 && status < 400 ? null : text, {status});
  assert.equal(await main(['GET', '/api/session'], {env, fetchImpl: respond(200), stdout: (l) => out.push(l), stderr: (l) => err.push(l)}), 0);
  assert.equal(await main(['GET', '/api/session'], {env, fetchImpl: respond(403, '{"ok":false}'), stdout: (l) => out.push(l), stderr: (l) => err.push(l)}), 2);
  assert.equal(await main(['GET', '/api/session'], {env, fetchImpl: respond(302), stdout: (l) => out.push(l), stderr: (l) => err.push(l)}), 2);
  assert.equal(await main(['GET', '/'], {env, fetchImpl: respond(200), stdout: (l) => out.push(l), stderr: (l) => err.push(l)}), 1);
  assert.equal(await main(['GET', '/api/session'], {env: {}, fetchImpl: respond(200), stdout: (l) => out.push(l), stderr: (l) => err.push(l)}), 1);
  for (const line of [...out, ...err]) assert.ok(!line.includes(SECRET) && !line.includes(ID), line);
});

test('--org は Cookie on_org で組織を選び、その組織になったと確かめてから本命を送る。なれなければ本命を送らずに止める', async () => {
  const env = {ON_STAGING_ACCESS_ID: ID, ON_STAGING_ACCESS_SECRET: SECRET};
  assert.equal(parseArgs(['POST', '/api/works', '--body', 'w.json', '--org', '7']).org, 7);
  // 架空の staging: 利用者 5 は組織 1（既定）と 7 に所属。所属していない組織の Cookie は既定の組織へ戻す
  const fake = (calls) => async (url, init) => {
    calls.push({path: new URL(url).pathname, method: init.method, cookie: init.headers.cookie ?? null});
    if (new URL(url).pathname === '/api/session') {
      const chosen = /^on_org=5:(\d+)$/.exec(init.headers.cookie ?? '')?.[1];
      const orgId = chosen && ['1', '7'].includes(chosen) ? Number(chosen) : 1;
      return new Response(JSON.stringify({ok: true, user: {id: 5, orgId}}), {status: 200});
    }
    return new Response('{"ok":true,"id":1}', {status: 201});
  };
  const ok = [];
  assert.equal(await main(['POST', '/api/works', '--body', 'w.json', '--org', '7'], {env, fetchImpl: fake(ok), stdout: () => {}, stderr: () => {}, readText: () => '{}'}), 0);
  assert.deepEqual(ok.at(-1), {path: '/api/works', method: 'POST', cookie: 'on_org=5:7'});
  const ng = []; const err = [];
  assert.equal(await main(['POST', '/api/works', '--body', 'w.json', '--org', '9'], {env, fetchImpl: fake(ng), stdout: () => {}, stderr: (l) => err.push(l), readText: () => '{}'}), 2);
  assert.ok(ng.every((c) => c.path === '/api/session'), '所属していない組織では本命（POST /api/works）を送らない');
  assert.match(err.join(''), /組織 9 を選べなかった/);
});
