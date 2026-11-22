// 本番の映画の基幹システムの受け口を、Cloudflare Access のサービストークンで呼ぶ（会社ルートの plans/2026-11-10-production-ai-token.md の B）。
// 代表が会話で指示した登録を、AI 専用のメンバー（ACCESS_SERVICE_TOKENS の読み替え先）として本番へ入れるための道具。手順は core の runbooks/20。
//
//   node scripts/production-api.mjs GET /api/session
//   node scripts/production-api.mjs POST /api/permits --body <JSON> [--org <組織の id>]            # 予行。送る内容を見せるだけで送らない
//   node scripts/production-api.mjs POST /api/permits --body <JSON> [--org <組織の id>] --apply    # 本番へ送る
//
// トークンの受け取り方は2つ。どちらも値を出力しない・URL や本文に入れない。
// - 代表の PC: production-api.ps1 が DPAPI の登録から ON_PRODUCTION_ACCESS_ID・ON_PRODUCTION_ACCESS_SECRET を子のプロセスにだけ渡す
// - クラウドのセッション: Client ID は環境変数 ON_PRODUCTION_ACCESS_ID（秘密ではない）。Client Secret は環境の秘密値としてプロキシが
//   見出し CF-Access-Client-Secret に付けるので、ON_PRODUCTION_ACCESS_SECRET_VIA_PROXY=1 のときは置き換えられる仮の値を送る（AI は値を読まない）
// 書き込み（POST・PUT・PATCH）は --apply が無ければ送らない（本番なので、送る内容を先に見せる）。呼べるのは /api/ の下だけ。
// 終了コード: 0 2xx（予行を含む）・1 使い方の誤り・2 受け口がエラーを返した
import {readFileSync, writeFileSync} from 'node:fs';
import {pathToFileURL} from 'node:url';
import {selectOrgCookie, ORG_ID, redact} from './staging-access.mjs';

export const PRODUCTION_ORIGIN = 'https://app.example.invalid';
export const ACCESS_ENV = Object.freeze({id: 'ON_PRODUCTION_ACCESS_ID', secret: 'ON_PRODUCTION_ACCESS_SECRET', viaProxy: 'ON_PRODUCTION_ACCESS_SECRET_VIA_PROXY'});
export const PROXY_PLACEHOLDER = 'injected-by-proxy';
const CLIENT_ID = /^[0-9a-f]{32}\.access$/;

export function productionToken(env = process.env) {
  const id = (env[ACCESS_ENV.id] ?? '').trim();
  if (!CLIENT_ID.test(id)) throw new Error(`${ACCESS_ENV.id} が無いか、形が違う（32桁の英数字のあとに .access）`);
  if (env[ACCESS_ENV.viaProxy] === '1') return {id, secret: PROXY_PLACEHOLDER, viaProxy: true};
  const secret = env[ACCESS_ENV.secret];
  if (!secret) throw new Error(`${ACCESS_ENV.secret} が無い（代表の PC では production-api.ps1 から呼ぶ。クラウドでは ${ACCESS_ENV.viaProxy}=1）`);
  return {id, secret, viaProxy: false};
}

export function parseArgs(argv) {
  const [method, path, ...rest] = argv;
  if (!['GET', 'POST', 'PUT', 'PATCH'].includes(method)) throw new Error('使い方: <GET|POST|PUT|PATCH> <受け口> …');
  if (typeof path !== 'string' || !path.startsWith('/api/') || /[\s#]|\.\./.test(path)) throw new Error('受け口は /api/ で始まる道にする');
  const options = {method, path, body: null, apply: false, out: null, org: null};
  for (let i = 0; i < rest.length; i += 1) {
    const flag = rest[i];
    if (flag === '--apply') { options.apply = true; continue; }
    const value = rest[i + 1];
    if (!['--body', '--out', '--org'].includes(flag) || !value) throw new Error(`わからない指定: ${flag}`);
    if (flag === '--org' && !ORG_ID.test(value)) throw new Error('--org は組織の id（1以上の整数）にする');
    options[flag.slice(2)] = flag === '--org' ? Number(value) : value; i += 1;
  }
  if (options.body && method === 'GET') throw new Error('GET に本文は付けない');
  if (method === 'GET' && options.apply) throw new Error('--apply は書き込みにだけ付ける');
  return options;
}

export function buildRequest(options, {id, secret, readText = (file) => readFileSync(file, 'utf8'), orgCookie = null}) {
  if (!id || !secret) throw new Error('トークンが渡されていない');
  let body;
  if (options.body) {
    body = readText(options.body).replace(/^﻿/, '');
    try { JSON.parse(body); } catch { throw new Error(`本文が JSON として読めない: ${options.body}`); }
  }
  const headers = {'CF-Access-Client-Id': id, 'CF-Access-Client-Secret': secret, accept: 'application/json'};
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (orgCookie) headers.cookie = orgCookie;
  // 書き込みは Worker の isSafeCloudRequest が Origin を本番の起点と同じかで確かめる（無いと 403）
  if (options.method !== 'GET') headers.origin = PRODUCTION_ORIGIN;
  return {url: PRODUCTION_ORIGIN + options.path, init: {method: options.method, headers, body, redirect: 'manual'}};
}

export async function main(argv, {env = process.env, fetchImpl = fetch, stdout = console.log, stderr = console.error, writeFile = writeFileSync, readText} = {}) {
  let options; let token; let request;
  try {
    options = parseArgs(argv);
    token = productionToken(env);
    request = buildRequest(options, {...token, ...(readText ? {readText} : {})});
  } catch (error) { stderr(`止まった: ${redact(error.message, token ?? {})}`); return 1; }
  const show = (text) => redact(text, token);
  if (options.method !== 'GET' && !options.apply) {
    stdout(`予行（本番へは送っていない）: ${options.method} ${request.url}${options.org ? `（組織 ${options.org}）` : ''}`);
    if (request.init.body !== undefined) stdout(show(JSON.stringify(JSON.parse(request.init.body), null, 2)));
    stdout('内容が代表の指示どおりなら --apply を付けて送る');
    return 0;
  }
  if (options.org) {
    let orgCookie;
    try { orgCookie = await selectOrgCookie({token, orgId: options.org, fetchImpl, origin: PRODUCTION_ORIGIN}); } catch (error) { stderr(`止まった: ${show(error.message)}`); return 2; }
    request = buildRequest(options, {...token, orgCookie, ...(readText ? {readText} : {})});
  }
  const response = await fetchImpl(request.url, request.init);
  if (response.status >= 300 && response.status < 400) { stderr(`止まった: ${response.status}（Access のログイン画面へ回された。トークンと Service Auth のポリシーを確かめる）`); return 2; }
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (options.out) { writeFile(options.out, bytes); stdout(`${response.status} ${bytes.length} バイトを ${options.out} に保存した`); }
  else stdout(`${response.status} ${show(new TextDecoder().decode(bytes))}`);
  return response.ok ? 0 : 2;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) process.exitCode = await main(process.argv.slice(2));
