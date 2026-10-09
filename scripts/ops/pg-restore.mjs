#!/usr/bin/env node
// 代表が取得した書き出しを空のPGへ戻す。接続はpg標準の環境変数から読み、値を出力しない。
import {readFile, mkdir, writeFile, realpath, stat} from 'node:fs/promises';
import {resolve, relative, dirname, isAbsolute} from 'node:path';
import {pathToFileURL} from 'node:url';
import {createRequire} from 'node:module';
import {parseArgs} from 'node:util';
import {PgDatabase} from '../../apps/integrated-prototype/src/data-platform/pg-db.mjs';
import {restorePgDatabase} from '../../apps/integrated-prototype/src/data-platform/pg-restore-store.mjs';
import {MAX_PART_BYTES, exportError, failureCause} from '../../apps/integrated-prototype/src/data-platform/pg-export-format.mjs';

export function directoryBucket(root) {
  const base = resolve(root);
  const pathFor = key => {
    if (typeof key !== 'string' || key.includes('\\') || key.includes(':') || key.split('/').some(p => !p || p === '..' || p === '.')) throw exportError('invalid_key');
    const path = resolve(base, key), rel = relative(base, path);
    if (isAbsolute(rel) || rel.startsWith('..')) throw exportError('invalid_path');
    return path;
  };
  const contained = async path => {
    const rel = relative(await realpath(base), await realpath(path));
    if (isAbsolute(rel) || rel.startsWith('..')) throw exportError('symlink_escape');
  };
  return {
    async get(key) {
      const path = pathFor(key);
      try {
        await contained(path);
        if ((await stat(path)).size > MAX_PART_BYTES) throw exportError('object_too_large');
        const bytes = await readFile(path);
        return {size: bytes.length, text: async () => bytes.toString('utf8'), arrayBuffer: async () => bytes};
      } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
    },
    async put(key, value) {
      const path = pathFor(key);
      await mkdir(dirname(path), {recursive: true});
      await contained(dirname(path));
      // 既存のファイルは同じ内容のときだけ受け付ける。参照先の上書きをしない。
      try { await writeFile(path, value, {flag: 'wx'}); }
      catch (error) {
        if (error.code !== 'EEXIST') throw error;
        await contained(path);
        if (!(await readFile(path)).equals(Buffer.from(value))) throw exportError('artifact_conflict');
      }
      return {key};
    },
  };
}

const loadPgClient = () => {
  const require = createRequire(new URL('../../apps/integrated-prototype/package.json', import.meta.url));
  return require('pg').Client;
};

// 失敗は {"event":"pg_restore_failed","cause":"<原因の種類>"} の1行だけを出す。原因の種類は書き出しと同じ許可リスト
// （failureCause: exportError の固定の語・SQLSTATE の5文字・それ以外は unexpected）。元のエラーの文・行・接続値は出さない。
// 0=戻した、1=失敗。loadClient・restore・out・err は試験で差し替える。
export async function restoreCli(argv, {loadClient = loadPgClient, restore = restorePgDatabase,
  out = line => console.log(line), err = line => console.error(line)} = {}) {
  let client, code = 0;
  try {
    let values;
    try {
      ({values} = parseArgs({args: argv, options: {archive: {type: 'string'}, manifest: {type: 'string'}, schema: {type: 'string'}, artifacts: {type: 'string'}, 'confirm-empty-target': {type: 'boolean'}}}));
    } catch { throw exportError('invalid_arguments'); }
    if (!values.archive || !values.manifest || !values.schema || !values['confirm-empty-target']) throw exportError('invalid_arguments');
    let schemaSql;
    try { schemaSql = await readFile(values.schema, 'utf8'); }
    catch (error) { if (error.code === 'ENOENT') throw exportError('input_missing'); throw error; }
    const Client = loadClient();
    client = new Client();
    client.on?.('error', () => { /* query/end の失敗だけを固定の文にして出す */ });
    await client.connect();
    const result = await restore({db: new PgDatabase(client), bucket: directoryBucket(values.archive), manifestKey: values.manifest,
      schemaSql, artifacts: values.artifacts ? directoryBucket(values.artifacts) : undefined});
    out(JSON.stringify(result));
  } catch (error) {
    err(JSON.stringify({event: 'pg_restore_failed', cause: failureCause(error)}));
    code = 1;
  } finally {
    if (client) {
      try { await client.end(); }
      catch (error) { err(JSON.stringify({event: 'pg_restore_close_failed', cause: failureCause(error)})); code = 1; }
    }
  }
  return code;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.exitCode = await restoreCli(process.argv.slice(2));
}
