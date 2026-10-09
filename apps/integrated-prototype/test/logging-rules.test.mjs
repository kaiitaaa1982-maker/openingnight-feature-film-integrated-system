// docs/rules/logging.md のうち、機械で守れる部分を確かめる。
// console は起動の知らせとエラーの受け止め口だけで使う。空の catch で失敗を黙らせない（既知の借りを除く）。
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync, readdirSync} from 'node:fs';
import {join, dirname, relative} from 'node:path';
import {fileURLToPath} from 'node:url';

const app = join(dirname(fileURLToPath(import.meta.url)), '..');

// console を使ってよいファイルと、その回数（増えたら落ちる）。
const CONSOLE_ALLOWED = new Map([
  ['src/data-platform/cloud-pg-export.mjs', 2], // scheduled は app.onError を通らない。成功（console.log）と失敗（console.error）の固定の名前の JSON 1行
  ['src/server.mjs', 1],             // 起動の知らせ
  ['src/server-production.mjs', 1],  // 起動の知らせ
  ['src/app.mjs', 1],                // app.onError（エラーの受け止め口）
  ['src/report-issuance-routes.mjs', 1], // 帳票の失敗
  ['src/preview/preview-main.mjs', 1],   // 閲覧用プレビュー（ブラウザ側）
  ['src/ui/ErrorBoundary.jsx', 1],        // 画面のエラーの受け止め口
]);

// 2026-09-30 時点の空の catch。返すべき借り（権限で外す失敗だけを受け止める形に直す）。直したら数を減らす。
const EMPTY_CATCH_DEBT = new Map([
  ['src/mg.mjs', 2],
  ['src/tax.mjs', 1],
  ['src/workbench.mjs', 2],
  ['src/workbench-analytics-local.mjs', 1],
  ['src/main.jsx', 6],               // 画面遷移の失敗
]);

const CONSOLE = /\bconsole\.(log|error|warn|info|debug)\s*\(/g;
const EMPTY_CATCH = /catch\s*(\(\s*[A-Za-z_$][\w$]*\s*\))?\s*\{\s*\}/g;

export const count = (text, pattern) => (text.match(pattern) || []).length;

function sourceFiles(dir, out = []) {
  for (const entry of readdirSync(dir, {withFileTypes: true})) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) sourceFiles(path, out);
    else if (/\.(mjs|jsx|js)$/.test(entry.name)) out.push(path);
  }
  return out;
}

const files = sourceFiles(join(app, 'src')).map(path =>
  ({rel: relative(app, path).replaceAll('\\', '/'), text: readFileSync(path, 'utf8')}));

function overLimit(pattern, allowed) {
  return files.map(f => ({file: f.rel, found: count(f.text, pattern), allowed: allowed.get(f.rel) || 0}))
    .filter(f => f.found > f.allowed);
}

test('console は決めた場所だけで使っている', () => {
  assert.deepEqual(overLimit(CONSOLE, CONSOLE_ALLOWED), [], 'エラーは app.onError に集める');
});

test('空の catch で失敗を黙らせていない（既知の借りを除く）', () => {
  assert.deepEqual(overLimit(EMPTY_CATCH, EMPTY_CATCH_DEBT), [], '予想した失敗かを確かめ、それ以外は投げ直す');
});

test('借りと許可の一覧は実態と合っている（直したら数を減らす）', () => {
  const stale = [...CONSOLE_ALLOWED, ...EMPTY_CATCH_DEBT].filter(([rel, n]) => {
    const file = files.find(f => f.rel === rel);
    const pattern = CONSOLE_ALLOWED.has(rel) && !EMPTY_CATCH_DEBT.has(rel) ? CONSOLE : EMPTY_CATCH;
    return !file || count(file.text, pattern) < n;
  }).map(([rel]) => rel);
  assert.deepEqual(stale, []);
});

test('検査は console と空の catch を見逃さない', () => {
  assert.equal(count("try { run() } catch {} console.log('x')", EMPTY_CATCH), 1);
  assert.equal(count("try { run() } catch (e) { } ", EMPTY_CATCH), 1);
  assert.equal(count("try { run() } catch (e) { throw e }", EMPTY_CATCH), 0);
  assert.equal(count("console.error(err); console.warn('a')", CONSOLE), 2);
});
