// 小道具の取込のスクリプト（scripts/import-props.mjs）。架空の見本 demo-fixtures/props/props-demo.json だけを使う。
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile, writeFile, mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {openTestDb} from './test-db.mjs';
import {createApp} from '../src/app.mjs';
import {createClient} from '../scripts/import-call-sheets.mjs';
import {importProps, parseArgs, runWithoutLocalDb} from '../scripts/import-props.mjs';

const demoPath = new URL('../demo-fixtures/props/props-demo.json', import.meta.url);
const source = JSON.parse(await readFile(demoPath, 'utf8'));

test('引数: 検査だけ・手元の DB・staging を分け、足りない指定と組み合わせの誤りを断る', () => {
  assert.equal(parseArgs(['--check-only', '--source', 'a.json']).mode, 'check');
  assert.deepEqual([parseArgs(['--db', 'x.sqlite', '--work-id', '3', '--source', 'a.json']).workId], [3]);
  assert.equal(parseArgs(['--staging', '--work-id', '2', '--source', 'a.json', '--org', '4']).org, 4);
  assert.throws(() => parseArgs(['--db', 'x.sqlite', '--source', 'a.json']), /--work-id/);
  assert.throws(() => parseArgs(['--staging', '--db', 'x', '--work-id', '2', '--source', 'a.json']), /一緒に使わない/);
  assert.throws(() => parseArgs(['--check-only']), /--source/);
});

test('検査だけ: 問題が無ければ件数と状態の内訳を出し、問題があれば並べて 1 で終わる', async (t) => {
  const out = [], err = [];
  const io = {stdout: (m) => out.push(m), stderr: (m) => err.push(m)};
  assert.equal((await runWithoutLocalDb(['--check-only', '--source', demoPath.pathname], io)).code, 0);
  assert.match(out[0], /品目 5件（未割当 1・要調整 2・手配中 1・用意済み 0・不要 1）/);
  const dir = await mkdtemp(join(tmpdir(), 'props-')); t.after(() => rm(dir, {recursive: true, force: true}));
  const broken = join(dir, 'broken.json');
  await writeFile(broken, JSON.stringify({items: [{key: 'a', name: 'x'}, {key: 'a', name: 'y', kind: 'weapon'}]}));
  assert.equal((await runWithoutLocalDb(['--check-only', '--source', broken], io)).code, 1);
  assert.deepEqual(err.slice(-2), ['- 2件目: key「a」が重なっています', '- 2件目: 種別を確認してください']);
});

test('受け口へ送る: 1回目は全部入り、2回目は飛ばす', async (t) => {
  const db = await openTestDb({t}), app = createApp({db, mode: 'local'});
  const login = await app.request('/api/local/login', {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify({email: 'admin@openingnight.invalid'})});
  const call = createClient({app, cookie: login.headers.get('set-cookie').split(';')[0]});
  const first = await importProps(call, source, {workId: 1});
  assert.deepEqual([first.created, first.skipped], [5, 0]);
  const again = await importProps(call, source, {workId: 1});
  assert.deepEqual([again.created, again.skipped, again.alreadyKnown], [0, 5, 5]);
  const list = (await call('GET', '/props?workId=1')).items;
  assert.deepEqual(list.map((r) => r.key), ['demo-001', 'demo-002', 'demo-003', 'demo-004', 'demo-005']);
});
