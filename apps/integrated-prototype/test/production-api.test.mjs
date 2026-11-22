// scripts/production-api.mjs（サービストークンで本番の受け口を呼ぶ道具）。値は架空。外へは送らない（fetch を差し替える）。
import test from 'node:test';
import assert from 'node:assert/strict';
import {parseArgs, buildRequest, main, productionToken, PRODUCTION_ORIGIN, PROXY_PLACEHOLDER} from '../scripts/production-api.mjs';

const ID = '0123456789abcdef0123456789abcdef.access';
const SECRET = 'fictional-production-secret';
const PC = {ON_PRODUCTION_ACCESS_ID: ID, ON_PRODUCTION_ACCESS_SECRET: SECRET};
const CLOUD = {ON_PRODUCTION_ACCESS_ID: ID, ON_PRODUCTION_ACCESS_SECRET_VIA_PROXY: '1'};
const BODY = JSON.stringify({kind: 'facility', place: '架空の集会室'});

const recorder = (status = 200, text = '{"ok":true}') => {
  const calls = [];
  const fetchImpl = async (url, init) => { calls.push({url, init}); return new Response(status >= 300 && status < 400 ? null : text, {status}); };
  return {calls, fetchImpl};
};
const sink = () => { const lines = []; return {lines, fn: (l) => lines.push(String(l))}; };

test('トークンは PC では Secret を環境変数から、クラウドではプロキシが付ける仮の値にする。Client ID の形が違えば止める', () => {
  assert.deepEqual(productionToken(PC), {id: ID, secret: SECRET, viaProxy: false});
  assert.deepEqual(productionToken(CLOUD), {id: ID, secret: PROXY_PLACEHOLDER, viaProxy: true});
  assert.throws(() => productionToken({ON_PRODUCTION_ACCESS_ID: ID}), /ON_PRODUCTION_ACCESS_SECRET/);
  assert.throws(() => productionToken({ON_PRODUCTION_ACCESS_ID: 'not-an-id', ON_PRODUCTION_ACCESS_SECRET: SECRET}), /形が違う/);
  assert.throws(() => productionToken({}), /ON_PRODUCTION_ACCESS_ID/);
});

test('呼べるのは /api/ の下だけで、GET に本文と --apply を付けない', () => {
  assert.deepEqual(parseArgs(['GET', '/api/session']), {method: 'GET', path: '/api/session', body: null, apply: false, out: null, org: null});
  for (const argv of [['DELETE', '/api/x'], ['GET', '/'], ['GET', 'https://example.invalid/api/x'], ['GET', '/api/../x'],
    ['GET', '/api/x', '--body', 'a.json'], ['GET', '/api/x', '--apply'], ['POST', '/api/x', '--manifest', 'm'], ['POST', '/api/x', '--org', '0']])
    assert.throws(() => parseArgs(argv), undefined, argv.join(' '));
});

test('要求は本番の起点へ送り、トークンは見出しにだけ載せ、書き込みには本番の Origin を付ける', () => {
  const post = buildRequest(parseArgs(['POST', '/api/permits', '--body', 'b.json']), {id: ID, secret: SECRET, readText: () => `﻿${BODY}`});
  assert.equal(post.url, `${PRODUCTION_ORIGIN}/api/permits`);
  assert.equal(post.init.headers.origin, PRODUCTION_ORIGIN);
  assert.equal(post.init.headers['CF-Access-Client-Id'], ID);
  assert.equal(post.init.headers['CF-Access-Client-Secret'], SECRET);
  assert.equal(post.init.redirect, 'manual');
  assert.equal(post.init.body, BODY);
  assert.ok(!post.url.includes(SECRET) && !post.init.body.includes(SECRET));
  assert.equal(buildRequest(parseArgs(['GET', '/api/session']), {id: ID, secret: SECRET}).init.headers.origin, undefined);
  assert.throws(() => buildRequest(parseArgs(['POST', '/api/x', '--body', 'b.json']), {id: ID, secret: SECRET, readText: () => '{壊れた'}), /JSON/);
});

test('書き込みは --apply が無ければ本番へ1件も送らず、送る内容を見せて 0 を返す', async () => {
  const {calls, fetchImpl} = recorder();
  const out = sink(); const err = sink();
  const code = await main(['POST', '/api/permits', '--body', 'b.json', '--org', '3'], {env: PC, fetchImpl, stdout: out.fn, stderr: err.fn, readText: () => BODY});
  assert.equal(code, 0);
  assert.equal(calls.length, 0, '組織の確かめも含めて何も送らない');
  assert.match(out.lines.join('\n'), /予行/);
  assert.match(out.lines.join('\n'), /架空の集会室/);
});

test('--apply では組織を確かめてから本命を送り、その組織でなければ本命を送らない', async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({url, init});
    if (url.endsWith('/api/session')) return Response.json({user: {id: 7, orgId: init.headers.cookie ? 3 : 1}});
    return Response.json({ok: true});
  };
  const out = sink();
  assert.equal(await main(['POST', '/api/permits', '--body', 'b.json', '--org', '3', '--apply'], {env: CLOUD, fetchImpl, stdout: out.fn, stderr: () => {}, readText: () => BODY}), 0);
  const last = calls.at(-1);
  assert.equal(last.url, `${PRODUCTION_ORIGIN}/api/permits`);
  assert.equal(last.init.headers.cookie, 'on_org=7:3');
  assert.equal(last.init.headers['CF-Access-Client-Secret'], PROXY_PLACEHOLDER, 'クラウドでは仮の値を送り、プロキシが置き換える');
  assert.ok(calls.slice(0, -1).every((c) => c.url === `${PRODUCTION_ORIGIN}/api/session`));

  const wrongOrg = [];
  const stays = async (url, init) => { wrongOrg.push(url); return Response.json({user: {id: 7, orgId: 1}}); };
  assert.equal(await main(['POST', '/api/permits', '--body', 'b.json', '--org', '3', '--apply'], {env: CLOUD, fetchImpl: stays, stdout: () => {}, stderr: () => {}, readText: () => BODY}), 2);
  assert.ok(wrongOrg.every((u) => u.endsWith('/api/session')), '組織を選べなければ本命を送らない');
});

test('main はトークンの値を出力せず、2xx で 0・エラーで 2・転送で 2・使い方の誤りで 1 を返す', async () => {
  const out = sink(); const err = sink();
  const io = {stdout: out.fn, stderr: err.fn};
  assert.equal(await main(['GET', '/api/session'], {env: PC, fetchImpl: recorder(200, `{"echo":"${SECRET}"}`).fetchImpl, ...io}), 0);
  assert.equal(await main(['GET', '/api/session'], {env: PC, fetchImpl: recorder(403, '{"ok":false}').fetchImpl, ...io}), 2);
  assert.equal(await main(['GET', '/api/session'], {env: PC, fetchImpl: recorder(302).fetchImpl, ...io}), 2);
  assert.equal(await main(['GET', '/'], {env: PC, fetchImpl: recorder().fetchImpl, ...io}), 1);
  assert.equal(await main(['GET', '/api/session'], {env: {}, fetchImpl: recorder().fetchImpl, ...io}), 1);
  const all = [...out.lines, ...err.lines].join('\n');
  assert.ok(!all.includes(SECRET), '応答に写った Secret も伏せる');
});
