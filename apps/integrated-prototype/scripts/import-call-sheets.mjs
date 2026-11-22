#!/usr/bin/env node
// 日々スケの JSON を統合システムへ登録する（中身は src/production/call-sheet-import.mjs。画面の「日々スケを取り込む」と同じ）。
// 使い方:
//   手元の SQLite: node scripts/import-call-sheets.mjs --db <SQLiteのパス> --source <JSON> --files <PDFのフォルダ> [--email <利用者>]
//   staging:       node scripts/import-call-sheets.mjs --staging --work-id <作品ID> --source <JSON> --files <PDFのフォルダ> [--org <組織の id>]
//                  （--org は操作する組織を選ぶ。選べなければ何も送らずに止まる。付けなければ既定の組織）
//                  （ふつうは scripts/import-call-sheets-staging.ps1 から。トークンは環境変数 ON_STAGING_ACCESS_ID・ON_STAGING_ACCESS_SECRET）
//   検査だけ:      node scripts/import-call-sheets.mjs --check-only --source <JSON> [--files <PDFのフォルダ>]（受け口を呼ばない）
// ・取り込む前に JSON の形と中の食い違いを確かめ（src/production/call-sheet-source-check.mjs）、問題があれば何も書かない。
// ・--db の指定は必須（staging・検査だけのときを除く）。data/integrated.sqlite へは --allow-main-db を付けたときだけ書く。
// ・2回流しても増えない（保管庫に同じファイル名・日付の原本がある版は飛ばす）。staging の受け口は予行を持たないので --dry-run は無い。
// 終了コード: 0 済んだ・1 JSON の問題か受け口のエラー・2 使い方の誤り
import {readFile, access} from 'node:fs/promises';
import {resolve, join} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {importCallSheets, isRegisteredSheet} from '../src/production/call-sheet-import.mjs';
import {checkCallSheetJson, formatProblem} from '../src/production/call-sheet-source-check.mjs';
import {STAGING_ORIGIN, ORG_ID, accessHeaders, accessToken, assertApiPath, redact, selectOrgCookie} from './staging-access.mjs';

export {importCallSheets};

export function createClient({app, cookie}) {
  return async (method, path, payload, headers = {}) => {
    const response = await app.request(`/api${path}`, {method, headers: {cookie, ...(payload === undefined ? {} : {'content-type': 'application/json'}), ...headers},
      body: payload === undefined ? undefined : JSON.stringify(payload)});
    const data = await response.json();
    if (response.status >= 300 || data.ok === false) throw new Error(`${method} ${path}: ${response.status} ${data.error || JSON.stringify(data).slice(0, 600)}`);
    return data;
  };
}

// createClient と同じ形の call を、staging の受け口へ fetch で作る。トークンは見出しにだけ載せ、エラーの文からも消す。
export function createStagingClient({token, fetchImpl = fetch, orgCookie = null}) {
  return async (method, path, payload, headers = {}) => {
    const apiPath = assertApiPath(`/api${path}`);
    const response = await fetchImpl(STAGING_ORIGIN + apiPath, {method, redirect: 'manual',
      headers: {...headers, ...(payload === undefined ? {} : {'content-type': 'application/json'}), ...accessHeaders(token, method), ...(orgCookie ? {cookie: orgCookie} : {})},
      body: payload === undefined ? undefined : JSON.stringify(payload)});
    if (response.status >= 300 && response.status < 400) throw new Error(`${method} ${path}: ${response.status}（Access のログイン画面へ回された。トークンと Service Auth のポリシーを確かめる）`);
    const text = await response.text();
    let data;
    try { data = JSON.parse(text); } catch { throw new Error(`${method} ${path}: ${response.status} JSON でない応答`); }
    if (response.status >= 300 || data?.ok === false) throw new Error(redact(`${method} ${path}: ${response.status} ${data?.error || text.slice(0, 600)}`, token));
    return data;
  };
}

export function parseArgs(argv) {
  const flags = new Set(['--staging', '--check-only', '--allow-main-db']);
  const values = new Set(['--db', '--source', '--files', '--email', '--work-id', '--org']);
  const options = {};
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    if (flags.has(flag)) { options[flag.slice(2)] = true; continue; }
    const value = argv[i + 1];
    if (!values.has(flag) || !value || value.startsWith('--')) throw new Error(`わからない指定: ${flag}`);
    options[flag.slice(2)] = value; i += 1;
  }
  if (!options.source) throw new Error('--source（日々スケの JSON）を指定してください');
  if (options['check-only']) return {mode: 'check', ...options};
  if (!options.files) throw new Error('--files（PDF のフォルダ）を指定してください');
  if (options.staging) {
    if (options.db || options.email || options['allow-main-db']) throw new Error('--staging と --db・--email・--allow-main-db は一緒に使わない');
    if (!/^[1-9]\d*$/.test(options['work-id'] || '')) throw new Error('--work-id（staging の作品 ID。正の整数）を指定してください');
    if (options.org !== undefined && !ORG_ID.test(options.org)) throw new Error('--org は組織の id（1以上の整数）にする');
    return {mode: 'staging', ...options, workId: Number(options['work-id']), org: options.org === undefined ? null : Number(options.org)};
  }
  if (options['work-id'] || options.org) throw new Error('--work-id・--org は --staging のときだけ使う');
  if (!options.db) throw new Error('--db（投入先の SQLite）・--source（日々スケの JSON）・--files（PDF のフォルダ）を指定してください');
  return {mode: 'db', ...options};
}

async function missingPdfs(sheets, folder) {
  const missing = [];
  for (const sheet of sheets) {
    try { await access(join(resolve(folder), sheet.file)); } catch { missing.push(sheet.file); }
  }
  return missing;
}

// 手元の DB を開かない段（引数と JSON の検査・--check-only・--staging）。終わったら {code}、手元の DB への投入なら {options, source, readPdf, log} を返し、main が続ける。
// 試験はこちらを呼ぶ（main は手元の DB を開くので、試験の決まりでは自前で DB を作る本になる）
export async function runWithoutLocalDb(argv, {env = process.env, fetchImpl = fetch, stdout = console.log, stderr = console.error} = {}) {
  let options;
  try { options = parseArgs(argv); } catch (error) { stderr(error.message); return {code: 2}; }
  let source;
  try { source = JSON.parse((await readFile(resolve(options.source), 'utf8')).replace(/^﻿/, '')); } catch (error) { stderr(`JSON を読めません: ${error.message}`); return {code: 1}; }
  const problems = checkCallSheetJson(source);
  if (problems.length) {
    stderr(`日々スケの JSON に ${problems.length} 件の問題があるので取り込まない:`);
    for (const problem of problems) stderr(`- ${formatProblem(problem)}`);
    return {code: 1};
  }
  const log = (m) => stdout(`  ${m}`);
  const readPdf = (name) => readFile(join(resolve(options.files), name));

  if (options.mode === 'check') {
    if (options.files) {
      const missing = await missingPdfs(source.sheets, options.files);
      if (missing.length) { stderr(`PDF が見つかりません: ${missing.join('、')}`); return {code: 1}; }
    }
    stdout(`問題はありません: 日々スケ ${source.sheets.length}枚（受け口は呼んでいない）`);
    return {code: 0};
  }

  if (options.mode === 'staging') {
    let token;
    try { token = accessToken(env); } catch (error) { stderr(error.message); return {code: 2}; }
    try {
      const orgCookie = options.org ? await selectOrgCookie({token, orgId: options.org, fetchImpl}) : null;
      const call = createStagingClient({token, fetchImpl, orgCookie});
      const work = (await call('GET', '/works')).rows.find((row) => row.id === options.workId);
      if (!work) { stderr(`staging に作品 ${options.workId} がありません（または見る権限が無い）`); return {code: 1}; }
      const placed = (await call('GET', `/preprod/works/${work.id}/documents`)).documents;
      const missing = await missingPdfs(source.sheets.filter((sheet) => !isRegisteredSheet(placed, sheet)), options.files);
      if (missing.length) { stderr(`PDF が見つかりません: ${missing.join('、')}`); return {code: 1}; }
      const result = await importCallSheets(call, source, {work, readPdf, log});
      stdout(`staging に登録しました: 作品 ${result.workId}・新しい版 ${result.applied.length}枚・登録済みで飛ばした版 ${result.skipped.length}枚`);
      return {code: 0};
    } catch (error) {
      stderr(`止まった: ${redact(error.message, token)}`);
      return {code: 1};
    }
  }
  return {options, source, readPdf, log};
}

export async function main(argv, io = {}) {
  const {stdout = console.log, stderr = console.error} = io;
  const step = await runWithoutLocalDb(argv, io);
  if (step.code !== undefined) return step.code;
  const {options, source, readPdf, log} = step;

  const mainDb = fileURLToPath(new URL('../data/integrated.sqlite', import.meta.url));
  if (resolve(options.db).toLowerCase() === resolve(mainDb).toLowerCase() && !options['allow-main-db']) {
    stderr('data/integrated.sqlite への投入は --allow-main-db を付けたときだけ行います。');
    return 2;
  }
  const [{LocalDatabase}, {createApp}] = await Promise.all([import('../src/db.mjs'), import('../src/app.mjs')]);
  const db = new LocalDatabase(resolve(options.db));
  try {
    const app = createApp({db, mode: 'local'});
    const login = await app.request('/api/local/login', {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify({email: options.email || 'admin@openingnight.invalid'})});
    if (login.status !== 200) throw new Error(`ログインできません（${login.status}）`);
    const call = createClient({app, cookie: login.headers.get('set-cookie').split(';')[0]});
    const result = await importCallSheets(call, source, {readPdf, log});
    stdout(`登録しました: 作品 ${result.workId}・新しい版 ${result.applied.length}枚・登録済みで飛ばした版 ${result.skipped.length}枚`);
    return 0;
  } finally {
    db.close();
  }
}

const isMain = Boolean(process.argv[1]) && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isMain) process.exitCode = await main(process.argv.slice(2));
