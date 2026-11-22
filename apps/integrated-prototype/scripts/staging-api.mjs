// staging の統合システムの受け口を、Cloudflare Access のサービストークンで呼ぶ（会社ルートの plans/2026-11-06-r2-ingest.md の B）。
// ふつうは staging-api.ps1 から呼ぶ（DPAPI で保存したトークンを環境変数 ON_STAGING_ACCESS_ID・ON_STAGING_ACCESS_SECRET に渡す）。
// トークンの値は出力しない。呼べるのは /api/ の下だけ。
//   node scripts/staging-api.mjs <GET|POST|PUT|PATCH> <受け口> [--body <JSON のファイル>] [--manifest <目録の TSV>] [--apply] [--out <保存先>] [--org <組織の id>]
// --org は操作する組織を選ぶ（画面の組織の切替と同じ Cookie on_org を付ける）。先に /api/session でその組織になったかを確かめ、
// なっていなければ（所属していない・無効で既定の組織へ戻った）本命の要求を送らずに止める。付けなければ既定の組織で動く。
// --manifest は POST /api/source-documents/import-r2-manifest の本文 {manifest, dryRun} を作る（--apply が無ければ dryRun: true）。
// 終了コード: 0 2xx・1 使い方の誤り・2 受け口がエラーを返した
import {readFileSync, writeFileSync} from 'node:fs';
import {pathToFileURL} from 'node:url';
import {selectOrgCookie, ORG_ID} from './staging-access.mjs';

export const STAGING_ORIGIN = 'https://staging.example.invalid';

export function parseArgs(argv) {
  const [method, path, ...rest] = argv;
  if (!['GET', 'POST', 'PUT', 'PATCH'].includes(method)) throw new Error('使い方: <GET|POST|PUT|PATCH> <受け口> …');
  if (typeof path !== 'string' || !path.startsWith('/api/') || /[\s#]|\.\./.test(path)) throw new Error('受け口は /api/ で始まる道にする');
  const options = {method, path, body: null, manifest: null, apply: false, out: null, org: null};
  for (let i = 0; i < rest.length; i += 1) {
    const flag = rest[i];
    if (flag === '--apply') { options.apply = true; continue; }
    const value = rest[i + 1];
    if (!['--body', '--manifest', '--out', '--org'].includes(flag) || !value) throw new Error(`わからない指定: ${flag}`);
    if (flag === '--org' && !ORG_ID.test(value)) throw new Error('--org は組織の id（1以上の整数）にする');
    options[flag.slice(2)] = flag === '--org' ? Number(value) : value; i += 1;
  }
  if (options.body && options.manifest) throw new Error('--body と --manifest は一緒に使わない');
  if ((options.body || options.manifest) && method === 'GET') throw new Error('GET に本文は付けない');
  return options;
}

export function buildRequest(options, {id, secret, readText = (file) => readFileSync(file, 'utf8'), orgCookie = null}) {
  if (!id || !secret) throw new Error('トークンが渡されていない（staging-api.ps1 から呼ぶ）');
  let body;
  if (options.manifest) body = JSON.stringify({manifest: readText(options.manifest).replace(/^\uFEFF/, ''), dryRun: !options.apply});
  else if (options.body) body = readText(options.body).replace(/^\uFEFF/, '');
  const headers = {'CF-Access-Client-Id': id, 'CF-Access-Client-Secret': secret, accept: 'application/json'};
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (orgCookie) headers.cookie = orgCookie;
  // 書き込みは Worker の isSafeCloudRequest が Origin を staging の起点と同じかで確かめる（無いと 403）
  if (options.method !== 'GET') headers.origin = STAGING_ORIGIN;
  return {url: STAGING_ORIGIN + options.path, init: {method: options.method, headers, body, redirect: 'manual'}};
}

export async function main(argv, {env = process.env, fetchImpl = fetch, stdout = console.log, stderr = console.error, writeFile = writeFileSync, readText} = {}) {
  let options; let request;
  const id = env.ON_STAGING_ACCESS_ID, secret = env.ON_STAGING_ACCESS_SECRET;
  try {
    options = parseArgs(argv);
    request = buildRequest(options, {id, secret, ...(readText ? {readText} : {})});
  } catch (error) { stderr(`止まった: ${error.message}`); return 1; }
  if (options.org) {
    let orgCookie;
    try { orgCookie = await selectOrgCookie({token: {id, secret}, orgId: options.org, fetchImpl}); } catch (error) { stderr(`止まった: ${error.message}`); return 2; }
    request = buildRequest(options, {id, secret, orgCookie, ...(readText ? {readText} : {})});
  }
  const response = await fetchImpl(request.url, request.init);
  if (response.status >= 300 && response.status < 400) { stderr(`止まった: ${response.status}（Access のログイン画面へ回された。トークンと Service Auth のポリシーを確かめる）`); return 2; }
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (options.out) { writeFile(options.out, bytes); stdout(`${response.status} ${bytes.length} バイトを ${options.out} に保存した`); }
  else stdout(`${response.status} ${new TextDecoder().decode(bytes)}`);
  return response.ok ? 0 : 2;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) process.exitCode = await main(process.argv.slice(2));
