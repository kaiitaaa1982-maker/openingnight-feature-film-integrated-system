// 代表が流す1本の ps1（scripts/measure-staging.ps1。PG 計画 段2の実測 S5〜S7）の試験。Windows PowerShell 5.1 で流す。
// ・https の向き先は、-NonInteractive では STAGING の確認で必ず止まり（終了コード 2）、cloudflared を呼ばず、結果のフォルダも作らない
// ・STAGING と打ったあとでも、cloudflared access token が失敗したら node を起動せずに止める（cloudflared は確認の後にだけ呼ぶ）
// ・手元のアプリ（http://127.0.0.1）へ、代表と同じ形の1行（-SkipSampler・1回の計画）で、読み取りだけの確認 → yes → 計測まで通る
// ・見本取り: 手元の Docker の postgres:18.6-alpine に、pg_read_all_data と pg_write_all_data だけを持つロールで接続（pg_sleep を含む）を張り、
//   見本取りの部分（-SamplerOnly）を流すと、接続の最大と最長の経過が数値だけで出て、止める合図で集計まで出て、コンテナが残らない。
//   アプリのロールが1つに決まらない・pg_read_all_stats を使えないときは、見本取りを始めずに止める（終了コード 3）
// powershell.exe（Windows）と Docker が無い環境では理由をつけて skip する。DB のパスワードは試験だけの偽物。架空のデータだけを使う
import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn, spawnSync} from 'node:child_process';
import {existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import pg from 'pg';
import {serve} from '@hono/node-server';
import {openTestDb} from './test-db.mjs';
import {seedSalesDemo} from '../scripts/seed-sales-demo.mjs';
import {createApp} from '../src/app.mjs';
import {extractDocument} from '../src/local-extractor.mjs';

const PS1 = resolve(import.meta.dirname, '..', 'scripts', 'measure-staging.ps1');
const python = process.env.ON_PYTHON || (process.platform === 'win32' ? 'python' : 'python3');
// 試験だけの偽物（秘密値ではない）。この試験で立てて消す手元の使い捨ての PostgreSQL にだけ使う
const FAKE_PASSWORD = 'measure-test-only-fake-password';
const ROLE = 'integrated_app_measure_probe';

const powershell = process.platform === 'win32'
  && spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', '$PSVersionTable.PSVersion.Major'], {encoding: 'utf8', timeout: 60000}).stdout?.trim() === '5';
const docker = powershell && spawnSync('docker', ['version', '--format', '{{.Server.Version}}'], {encoding: 'utf8', timeout: 20000}).status === 0;
const NO_POWERSHELL = 'Windows PowerShell 5.1（powershell.exe）が無い環境（CI の WSL など）';

function tempDir(t, prefix) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  t.after(() => rmSync(dir, {recursive: true, force: true}));
  return dir;
}

// ps1 を代表と同じ形（powershell -ExecutionPolicy Bypass -File …）で流す。input は Read-Host への答え
function runPs1(args, {env = {}, input = '', nonInteractive = false} = {}) {
  return new Promise((done) => {
    const pathKey = Object.keys(process.env).find((key) => key.toUpperCase() === 'PATH') || 'PATH';
    const merged = {...process.env, ...env};
    if (env.PATH) { merged[pathKey] = env.PATH; if (pathKey !== 'PATH') delete merged.PATH; }
    for (const name of ['ON_ACCESS_TOKEN', 'PGHOST', 'PGPORT', 'PGUSER', 'PGPASSWORD', 'PGDATABASE']) if (!(name in env)) delete merged[name];
    const child = spawn('powershell.exe', ['-NoProfile', ...(nonInteractive ? ['-NonInteractive'] : []), '-ExecutionPolicy', 'Bypass', '-File', PS1, ...args], {env: merged, windowsHide: true});
    const chunks = [];
    child.stdout.on('data', (chunk) => chunks.push(chunk));
    child.stderr.on('data', (chunk) => chunks.push(chunk));
    child.on('close', (code) => done({code, output: Buffer.concat(chunks).toString('latin1')}));
    child.stdin.end(input);
  });
}

// 呼ばれたら印を残して失敗する cloudflared の偽物
function fakeCloudflared(t) {
  const dir = tempDir(t, 'measure-ps1-cf-');
  writeFileSync(join(dir, 'cloudflared.cmd'), '@echo off\r\necho called>"%~dp0called.txt"\r\nexit /b 1\r\n');
  const pathKey = Object.keys(process.env).find((key) => key.toUpperCase() === 'PATH') || 'PATH';
  return {dir, marker: join(dir, 'called.txt'), PATH: `${dir};${process.env[pathKey]}`};
}

test('https の向き先は -NonInteractive では STAGING の確認で止まり（終了コード 2）、cloudflared を呼ばず、結果のフォルダも作らない',{skip: powershell ? false : NO_POWERSHELL}, async (t) => {
  const fake = fakeCloudflared(t);
  const out = join(tempDir(t, 'measure-ps1-'), 'result');
  const run = await runPs1(['-Url', 'https://staging.example.invalid', '-OutDir', out], {env: {PATH: fake.PATH}, nonInteractive: true});
  // 尋ねられないことは「確認が取れない」なので、始める前に止めた（2）。Read-Host の例外のまま 1（思わぬ誤り）にしない
  assert.equal(run.code, 2, run.output.slice(-2000));
  assert.equal(existsSync(fake.marker), false, 'cloudflared を呼ばない');
  assert.equal(existsSync(out), false, '結果のフォルダを作らない');
});

test('STAGING と打ったあとでも、cloudflared access token が失敗したら node を起動せずに止める（終了コード 2）', {skip: powershell ? false : NO_POWERSHELL}, async (t) => {
  const fake = fakeCloudflared(t);
  const out = join(tempDir(t, 'measure-ps1-'), 'result');
  // .invalid の向き先（届かない）。cloudflared の偽物は失敗するので、node は起動しない
  const run = await runPs1(['-Url', 'https://integrated-staging.example.invalid', '-OutDir', out], {env: {PATH: fake.PATH}, input: 'STAGING\r\n'});
  assert.equal(run.code, 2);
  assert.equal(existsSync(fake.marker), true, '確認の後に cloudflared を呼んだ');
  assert.equal(existsSync(out), false, 'node を起動していない（結果のフォルダが無い）');
});

test('手元のアプリへ代表と同じ形の1行で、読み取りだけの確認 → yes → 計測まで通り、結果を UTF-8 の JSON で書く', {skip: powershell ? false : NO_POWERSHELL}, async (t) => {
  const db = await openTestDb({t});
  await seedSalesDemo(db);
  const app = createApp({db, mode: 'local', extractDocument: (args) => extractDocument({...args, pythonPath: python})});
  const baseUrl = await new Promise((done) => {
    const server = serve({fetch: app.fetch, hostname: '127.0.0.1', port: 0}, (info) => done(`http://127.0.0.1:${info.port}`));
    t.after(() => new Promise((closed) => server.close(() => closed())));
  });
  const out = join(tempDir(t, 'measure-ps1-'), 'measure-local');
  const run = await runPs1(['-Url', baseUrl, '-SkipSampler', '-Plan', 'a:2026-06', '-OutDir', out], {input: 'yes\r\n'});
  assert.equal(run.code, 0, run.output.slice(-2000));
  const check = JSON.parse(readFileSync(join(out, 'check-only.json'), 'utf8'));
  assert.equal(check.outcome, 'check-only');
  assert.deepEqual(check.checks.map((row) => row.state), ['ready']);
  const report = JSON.parse(readFileSync(join(out, 'measure.json'), 'utf8'));
  assert.equal(report.outcome, 'complete');
  assert.deepEqual(report.runs.map((row) => [row.source, row.month, row.status]), [['a', '2026-06', 'measured']]);
  assert.equal(report.runs[0].result.forecastImmediate, true);
  assert.match(readFileSync(join(out, 'measure.md'), 'utf8'), /## 取込から予実までの時間/);
  assert.equal(existsSync(join(out, 'pg-sampler.json')), false, '-SkipSampler では見本取りをしない');
});

function sh(args, timeout = 120000) {
  const result = spawnSync('docker', args, {encoding: 'utf8', timeout});
  return {code: result.status, out: (result.stdout || '').trim()};
}

async function connectWhenReady(config) {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const client = new pg.Client(config);
    try {
      await client.connect();
      return client;
    } catch {
      await client.end().catch(() => {});
      await new Promise((wait) => setTimeout(wait, 500));
    }
  }
  throw new Error('手元の PostgreSQL に接続できない');
}

test('見本取り: アプリのロールの接続（pg_sleep を含む）の最大と最長の経過を数値だけで出し、止める合図で集計まで出てコンテナが残らない。ロールが決まらない・統計を読めないときは始めない', {skip: docker ? false : `${NO_POWERSHELL}、または Docker が応えない`, timeout: 600000}, async (t) => {
  const server = `on-measure-sampler-test-pg-${process.pid}`;
  const sampler = `on-measure-sampler-test-${process.pid}`;
  const clients = [];
  t.after(async () => {
    await Promise.allSettled(clients.map((client) => client.end()));
    sh(['rm', '-f', sampler]);
    sh(['rm', '-f', server]);
  });
  sh(['rm', '-f', server]);
  assert.equal(sh(['run', '-d', '--name', server, '-e', `POSTGRES_PASSWORD=${FAKE_PASSWORD}`, '-p', '127.0.0.1::5432', 'postgres:18.6-alpine'], 300000).code, 0);
  const port = Number(sh(['port', server, '5432']).out.split('\n')[0].split(':').at(-1));
  const config = {host: '127.0.0.1', port, user: 'postgres', password: FAKE_PASSWORD, database: 'postgres'};
  const admin = await connectWhenReady(config);
  clients.push(admin);
  await admin.query(`CREATE ROLE ${ROLE} LOGIN PASSWORD '${FAKE_PASSWORD}'`);
  await admin.query(`GRANT pg_read_all_data, pg_write_all_data TO ${ROLE}`);
  for (let index = 0; index < 3; index += 1) {
    const client = new pg.Client({...config, user: ROLE});
    await client.connect();
    clients.push(client);
  }
  // 1本は見本取りのあいだずっと active（最長の経過が出る）
  const sleeping = clients[1].query('SELECT pg_sleep(30)').catch(() => {});
  const env = {PGHOST: 'host.docker.internal', PGPORT: String(port), PGUSER: 'postgres', PGPASSWORD: FAKE_PASSWORD};
  const base = tempDir(t, 'measure-ps1-sampler-');
  const args = (dir) => ['-Url', 'http://127.0.0.1:9', '-SamplerOnly', '-SamplerSeconds', '5', '-SslMode', 'disable', '-ContainerName', sampler, '-OutDir', join(base, dir)];

  const run = await runPs1(args('ok'), {env});
  assert.equal(run.code, 0, run.output.slice(-2000));
  const summary = JSON.parse(readFileSync(join(base, 'ok', 'pg-sampler.json'), 'utf8'));
  assert.ok(summary.samples >= 3, `見本が1秒ごとに取れている: ${summary.samples}`);
  assert.equal(summary.maxAppConnections, 3, 'アプリのロールの接続だけを数える');
  assert.ok(summary.maxActiveMs >= 1000, `pg_sleep の経過が出る: ${summary.maxActiveMs}`);
  assert.ok(summary.maxTotalConnections >= 5, '全体の接続（管理・アプリの3本・見本取り）');
  assert.equal(summary.maxConnections, 100);
  const lines = readFileSync(join(base, 'ok', 'pg-samples.csv'), 'utf8').trim().split('\n');
  assert.equal(lines.length, summary.samples);
  assert.ok(lines.every((line) => /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3},\d+,\d+,\d+,\d+$/.test(line.trim())), '見出しの無い1行の CSV');
  assert.equal(sh(['ps', '-a', '--filter', `name=^/${sampler}$`, '--format', '{{.Names}}']).out, '', '見本取りのコンテナが残らない');
  for (const secret of [FAKE_PASSWORD, ROLE, 'host.docker.internal', 'pg_stat_activity', 'pg_roles']) assert.equal(run.output.includes(secret), false, `出力に ${secret} が出ない`);

  // 統計を読めないロール（pg_read_all_stats が無い）では始めない
  const noStats = await runPs1(args('no-stats'), {env: {...env, PGUSER: ROLE}});
  assert.equal(noStats.code, 3);
  assert.equal(existsSync(join(base, 'no-stats', 'pg-sampler.json')), false);
  // アプリのロールが2つあると1つに決まらないので始めない
  await admin.query(`CREATE ROLE ${ROLE}_2 LOGIN PASSWORD '${FAKE_PASSWORD}'`);
  await admin.query(`GRANT pg_read_all_data, pg_write_all_data TO ${ROLE}_2`);
  const twoRoles = await runPs1(args('two-roles'), {env});
  assert.equal(twoRoles.code, 3);
  assert.equal(existsSync(join(base, 'two-roles', 'pg-samples.csv')), false);
  assert.equal(sh(['ps', '-a', '--filter', `name=^/${sampler}$`, '--format', '{{.Names}}']).out, '');
  for (const output of [noStats.output, twoRoles.output]) assert.equal(output.includes(FAKE_PASSWORD) || output.includes(ROLE), false);
  await admin.query('SELECT pg_cancel_backend(pid) FROM pg_stat_activity WHERE usename = $1', [ROLE]);
  await sleeping;
});
