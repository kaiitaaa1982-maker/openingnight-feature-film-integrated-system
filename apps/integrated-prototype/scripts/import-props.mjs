#!/usr/bin/env node
// 小道具の品目の JSON を統合システムへ登録する（受け口は POST /api/props/import。会社ルートの plans/2026-11-09-props-meeting.md の香盤表 #8）。
// 使い方:
//   手元の SQLite: node scripts/import-props.mjs --db <SQLiteのパス> --work-id <作品ID> --source <JSON> [--email <利用者>]
//   staging:       node scripts/import-props.mjs --staging --work-id <作品ID> --source <JSON> [--org <組織の id>]
//                  （トークンは環境変数 ON_STAGING_ACCESS_ID・ON_STAGING_ACCESS_SECRET。staging への反映は代表が流す）
//   検査だけ:      node scripts/import-props.mjs --check-only --source <JSON>（受け口を呼ばない）
// JSON の形: {"work": {"code": …, "title": …}（任意。照合の表示だけに使う）, "items": [{"key": 一意の鍵, "name": 品目, …版の本文}]}
//   版の本文は sceneLabel・shootOn・place・quantity・kind・department・ownerLabel・state・nextAction・dueOn・source・scriptNote・memo（src/preprod/props/props-model.mjs）
// ・取り込む前に JSON の形と中身を確かめ（checkImport）、問題があれば何も書かない。
// ・2回流しても増えない（作品に登録済みの key は飛ばす）。data/integrated.sqlite へは --allow-main-db を付けたときだけ書く。
// 終了コード: 0 済んだ・1 JSON の問題か受け口のエラー・2 使い方の誤り
import {readFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {checkImport, formatProblem, stateCounts, PROP_STATES} from '../src/preprod/props/props-model.mjs';
import {createClient, createStagingClient} from './import-call-sheets.mjs';
import {ORG_ID, accessToken, redact, selectOrgCookie} from './staging-access.mjs';

export function parseArgs(argv) {
  const flags = new Set(['--staging', '--check-only', '--allow-main-db']);
  const values = new Set(['--db', '--source', '--email', '--work-id', '--org']);
  const options = {};
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    if (flags.has(flag)) { options[flag.slice(2)] = true; continue; }
    const value = argv[i + 1];
    if (!values.has(flag) || !value || value.startsWith('--')) throw new Error(`わからない指定: ${flag}`);
    options[flag.slice(2)] = value; i += 1;
  }
  if (!options.source) throw new Error('--source（品目の JSON）を指定してください');
  if (options['check-only']) return {mode: 'check', ...options};
  if (!/^[1-9]\d*$/.test(options['work-id'] || '')) throw new Error('--work-id（作品 ID。正の整数）を指定してください');
  const workId = Number(options['work-id']);
  if (options.staging) {
    if (options.db || options.email || options['allow-main-db']) throw new Error('--staging と --db・--email・--allow-main-db は一緒に使わない');
    if (options.org !== undefined && !ORG_ID.test(options.org)) throw new Error('--org は組織の id（1以上の整数）にする');
    return {mode: 'staging', ...options, workId, org: options.org === undefined ? null : Number(options.org)};
  }
  if (options.org) throw new Error('--org は --staging のときだけ使う');
  if (!options.db) throw new Error('--db（投入先の SQLite）を指定してください');
  return {mode: 'db', ...options, workId};
}

// 受け口へ送る（call は createClient・createStagingClient の形）。作品の存在と書く権限は受け口が確かめる
export async function importProps(call, source, {workId}) {
  const before = new Set((await call('GET', `/props?workId=${workId}`)).items.map((r) => r.key));
  const result = await call('POST', '/props/import', {workId, items: source.items});
  return {...result, alreadyKnown: before.size};
}

export function summary(source) {
  const counts = stateCounts(source.items.map((i) => ({state: i.state || 'unassigned'})));
  return Object.entries(PROP_STATES).map(([k, l]) => `${l} ${counts[k]}`).join('・');
}

// 手元の DB を開かない段（引数と JSON の検査・--check-only・--staging）
export async function runWithoutLocalDb(argv, {env = process.env, fetchImpl = fetch, stdout = console.log, stderr = console.error} = {}) {
  let options;
  try { options = parseArgs(argv); } catch (error) { stderr(error.message); return {code: 2}; }
  let source;
  try { source = JSON.parse((await readFile(resolve(options.source), 'utf8')).replace(/^﻿/, '')); } catch (error) { stderr(`JSON を読めません: ${error.message}`); return {code: 1}; }
  const {problems} = checkImport(source);
  if (problems.length) {
    stderr(`品目の JSON に ${problems.length} 件の問題があるので取り込まない:`);
    for (const problem of problems) stderr(`- ${formatProblem(problem)}`);
    return {code: 1};
  }
  if (options.mode === 'check') {
    stdout(`問題はありません: 品目 ${source.items.length}件（${summary(source)}）。受け口は呼んでいない`);
    return {code: 0};
  }
  if (options.mode === 'staging') {
    let token;
    try { token = accessToken(env); } catch (error) { stderr(error.message); return {code: 2}; }
    try {
      const orgCookie = options.org ? await selectOrgCookie({token, orgId: options.org, fetchImpl}) : null;
      const call = createStagingClient({token, fetchImpl, orgCookie});
      const result = await importProps(call, source, {workId: options.workId});
      stdout(`staging に登録しました: 作品 ${result.workId}・新しい品目 ${result.created}件・登録済みで飛ばした品目 ${result.skipped}件`);
      return {code: 0};
    } catch (error) {
      stderr(`止まった: ${redact(error.message, token)}`);
      return {code: 1};
    }
  }
  return {options, source};
}

export async function main(argv, io = {}) {
  const {stdout = console.log, stderr = console.error} = io;
  const step = await runWithoutLocalDb(argv, io);
  if (step.code !== undefined) return step.code;
  const {options, source} = step;
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
    const result = await importProps(call, source, {workId: options.workId});
    stdout(`登録しました: 作品 ${result.workId}・新しい品目 ${result.created}件・登録済みで飛ばした品目 ${result.skipped}件`);
    return 0;
  } catch (error) {
    stderr(`止まった: ${error.message}`);
    return 1;
  } finally {
    db.close();
  }
}

const isMain = Boolean(process.argv[1]) && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isMain) process.exitCode = await main(process.argv.slice(2));
