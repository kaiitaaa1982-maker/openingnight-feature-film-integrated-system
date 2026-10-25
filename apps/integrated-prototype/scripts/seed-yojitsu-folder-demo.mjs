#!/usr/bin/env node
// 予実管理のフォルダ（会社ルートの plans/2026-10-22-folder-yojitsu.md）を画面で確かめるための架空の種を、使い捨ての SQLite に入れる。
// 種は試験と同じ test/fixtures/yojitsu/（案件収支の予実の架空の種）と test/fixtures/receipt-matching/（架空の請求・入金）。架空のデータだけ。
// 使い方: node scripts/seed-yojitsu-folder-demo.mjs --db <SQLiteのパス>
//   data/integrated.sqlite へは書かない。本番の D1・Cloudflare・設定・秘密値には触れない
import {resolve, basename} from 'node:path';
import {LocalDatabase} from '../src/db.mjs';
import {loadYojitsuSeed} from '../test/yojitsu-view-fixture.mjs';

const args = process.argv.slice(2);
const dbPath = args[args.indexOf('--db') + 1];
if (!args.includes('--db') || !dbPath) { console.error('--db <SQLiteのパス> を渡してください'); process.exit(2); }
if (basename(resolve(dbPath)) === 'integrated.sqlite' && resolve(dbPath).includes(`${resolve('data')}`)) { console.error('手元の data/integrated.sqlite には書きません'); process.exit(2); }
const db = new LocalDatabase(resolve(dbPath));
await loadYojitsuSeed(db);
console.log('OK 予実の架空の種を入れました（ログインは demo-admin@openingnight.invalid）');
