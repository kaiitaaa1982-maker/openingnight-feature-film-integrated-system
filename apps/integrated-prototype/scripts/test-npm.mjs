#!/usr/bin/env node
// npm test — 統合システムの試験を、引数なしなら全部、--test-shard=i/n ならその組だけ流す。
//
// package.json の test が `node --test … test/*.test.mjs` のままだと、
// `npm test -- --test-shard=1/2` は旗がファイルの後ろに付く。Node はその旗を見ずに全部を流す。
// この入口が旗を先に読み、選んだファイルだけを node --test に渡す。書き違いと知らない旗は終了コード 2。
// 割り方は Node の --test-shard と同じ（名前順に並べて n 本おきに i 組目）。
//
//   node scripts/test-npm.mjs                      全試験
//   node scripts/test-npm.mjs test/a.test.mjs …    指定したファイルだけ
//   node scripts/test-npm.mjs --list               流すファイルの一覧と数だけを出す
//   node scripts/test-npm.mjs --test-shard=1/2     名前順に 2 本おきの 1 組目
import { spawn } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const app = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const fail = (message) => {
  console.error(message);
  process.exit(2);
};
for (const a of args) if (a.startsWith('--') && a !== '--list' && !a.startsWith('--test-shard=')) fail(`知らない旗: ${a}`);
const listOnly = args.includes('--list');
const shardArg = args.find((a) => a.startsWith('--test-shard='));
let shard = null;
if (shardArg) {
  const m = shardArg.slice('--test-shard='.length).match(/^([1-9]\d*)\/([1-9]\d*)$/);
  if (!m || Number(m[1]) > Number(m[2])) fail(`--test-shard は i/n（1 ≤ i ≤ n）で書く: ${shardArg}`);
  shard = { index: Number(m[1]), total: Number(m[2]) };
}
const named = args.filter((a) => !a.startsWith('--'));
const allNames = readdirSync(join(app, 'test')).filter((name) => name.endsWith('.test.mjs')).sort();
const all = named.length
  ? named.map((f) => relative(app, resolve(app, f)).replaceAll('\\', '/'))
  : allNames.map((name) => `test/${name}`);
const files = shard ? [...all].sort().filter((_, i) => i % shard.total === shard.index - 1) : all;
const part = shard ? `・${shard.total} 分割の ${shard.index}` : '';

if (listOnly) {
  // パイプへの console.log は非同期なので、直後の process.exit で末尾が切れる（一覧が 64KB を超えると CI で起きた）。書き切ってから終わる
  process.stdout.write([...files, `流すファイル ${files.length}（全 ${allNames.length}${part}）`].join('\n') + '\n', () => process.exit(0));
} else {
  console.log(`${files.length} ファイルを流す（全 ${allNames.length}${part}）`);
  if (files.length === 0) process.exit(0);
  const child = spawn(process.execPath, ['--test', '--test-concurrency=1', ...files], { cwd: app, stdio: 'inherit' });
  child.on('exit', (code, signal) => process.exit(signal ? 1 : code ?? 1));
}
