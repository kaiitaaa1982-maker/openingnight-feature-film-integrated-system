#!/usr/bin/env node
// npm run test:pg — 試験を PostgreSQL で流す（PG 計画 段1「試験の二重化」・香盤表 #11）。
// test/pg-matrix.json の pending（PostgreSQL でまだ落ちる本）と sqliteOnly（SQLite だけで流す本）を除いた全試験を、
// ON_TEST_DB=pg で流す。ファクトリ（test/test-db.mjs）を通る試験は PostgreSQL の DB で動き、DB を使わない試験はそのまま流れる。
// ON_TEST_PG_URL（localhost だけ）があれば手元の PostgreSQL（CI の postgres:18.6-alpine）、無ければ PGlite で流す。
//
//   node scripts/test-pg.mjs                       一覧の外の全試験
//   node scripts/test-pg.mjs test/a.test.mjs …     指定したファイルだけ（一覧の中のファイルも流せる。pending を直すとき）
//   node scripts/test-pg.mjs --list                流すファイルの一覧と数だけを出す
import { spawn } from 'node:child_process';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pgTestFiles, readMatrix, TEST_DIR, testFiles } from '../test/pg-matrix.mjs';

const app = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const listOnly = args.includes('--list');
const named = args.filter((a) => !a.startsWith('--'));
const matrix = readMatrix();
const files = named.length ? named.map((f) => relative(app, resolve(app, f)).replaceAll('\\', '/')) : pgTestFiles(matrix, testFiles()).map((f) => relative(app, join(TEST_DIR, f)).replaceAll('\\', '/'));

if (listOnly) {
  for (const f of files) console.log(f);
  console.log(`流すファイル ${files.length}（全 ${testFiles().length}・pending ${matrix.pending.length}・sqliteOnly ${matrix.sqliteOnly.length}）`);
  process.exit(0);
}
const where = process.env.ON_TEST_PG_URL ? '手元の PostgreSQL（ON_TEST_PG_URL）' : 'PGlite';
console.log(`ON_TEST_DB=pg・${where} で ${files.length} ファイルを流す（pending ${matrix.pending.length}・sqliteOnly ${matrix.sqliteOnly.length} を除く）`);
const child = spawn(process.execPath, ['--test', '--test-concurrency=1', ...files], { cwd: app, stdio: 'inherit', env: { ...process.env, ON_TEST_DB: 'pg' } });
child.on('exit', (code, signal) => process.exit(signal ? 1 : code ?? 1));
