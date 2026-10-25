// 差分の移行（PG 計画 段2の実測 S14）の ps1 の試験。Windows PowerShell 5.1 で、代表と同じ形（powershell.exe -NoProfile -ExecutionPolicy Bypass -File）で流す。
// ・練習 G（scripts/pg-drill-migrate.ps1）: 試験が立てて消す手元の Docker の postgres:18.6-alpine に、起点（0011）までの全体と架空の行・R2 へ逃がした値
//   （架空の原本2つ）を入れて exportPgDatabase で書き出した世代を、練習 F の作業フォルダと同じ形（<根>\pg-F-<時刻>\pg-daily\<世代>\）に置く。
//   ps1 が起点の版で戻し、差分を psql の -1 で当て、新しい全体のコンテナと定義・照合・新しい表の行の数を比べ、数値だけの pg-G-result.json を書いて
//   両方のコンテナを消す。最後の移行の版の世代では「当てるものが無い」で止まる
// ・pg-staging.ps1 の migrate-dryrun・migrate・catalog（-LocalContainer）: trust で立てた手元のコンテナに起点の全体を当て、catalog が直書きの数なしで
//   「差分が当たっていない」を出し、予行は何も変えず、本番で版の印が新しい全体と同じになり、2回目は当てるものが無い。版の印がずれた DB は
//   base_mismatch の案内で止まり、別の接続が表を押さえているあいだは 55P03 で止まって何も変わらない
// Cloudflare・PlanetScale には届かない。powershell.exe（Windows）・Docker・postgres:18.6-alpine の像が無い環境では理由をつけて skip する。
// DB のパスワードは試験だけの偽物。架空のデータだけを使う
import test, {after} from 'node:test';
import assert from 'node:assert/strict';
import {spawn, spawnSync} from 'node:child_process';
import {existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import pg from 'pg';
import {convertDelta, convertMigrations} from '../scripts/pg-ddl.mjs';
import {PgDatabase} from '../src/data-platform/pg-db.mjs';
import {exportPgDatabase, sha256} from '../src/data-platform/pg-export-store.mjs';
import {directoryBucket} from '../../../scripts/ops/pg-restore.mjs';
import {TEST_CONTAINER, removeStaleTestContainers} from './docker-test-containers.mjs';

const APP = resolve(import.meta.dirname, '..');
const G_PS1 = join(APP, 'scripts', 'pg-drill-migrate.ps1');
const STAGING_PS1 = join(APP, 'scripts', 'pg-staging.ps1');
const IMAGE = 'postgres:18.6-alpine';
const BASE = '0011_cloud_analytics.sql';
const LAST = readdirSync(join(APP, 'migrations')).filter((f) => /^\d{4}_.+\.sql$/.test(f)).sort().at(-1);
// 試験だけの偽物（秘密値ではない）。この試験で立てて消す手元の使い捨ての PostgreSQL にだけ使う
const FAKE_PASSWORD = 'migrate-test-only-fake-password';
// 一時のフォルダは長い名前の形にし、名前に空白を入れる（代表の %USERPROFILE% は空白を含む）
const TMP = realpathSync.native(tmpdir());

const powershell = process.platform === 'win32'
  && spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', '$PSVersionTable.PSVersion.Major'], {encoding: 'utf8', timeout: 60000}).stdout?.trim() === '5';
const docker = powershell && spawnSync('docker', ['version', '--format', '{{.Server.Version}}'], {encoding: 'utf8', timeout: 20000}).status === 0;
const image = docker && spawnSync('docker', ['image', 'inspect', '--format', '{{.Id}}', IMAGE], {encoding: 'utf8', timeout: 20000}).status === 0;
const SKIP = !powershell ? 'Windows PowerShell 5.1（powershell.exe）が無い環境（CI の WSL など）'
  : !docker ? 'Docker が無いか20秒のうちに応えない環境'
    : !image ? `${IMAGE} の像が手元に無い（docker pull ${IMAGE} のあとに流す）` : false;
// 前の回が途中で殺されて残したコンテナ（名前の pid のプロセスがもう無いもの）を、始めに片づける
if (!SKIP) removeStaleTestContainers();

const cleanups = [];
after(async () => { for (const step of cleanups.reverse()) await step(); });

function tempDir(t, prefix) {
  const dir = mkdtempSync(join(TMP, `${prefix} `));
  t.after(() => rmSync(dir, {recursive: true, force: true}));
  return dir;
}
function sh(args, {input, timeout = 120000} = {}) {
  const run = spawnSync('docker', args, {encoding: 'utf8', timeout, input});
  return {code: run.status, out: (run.stdout || '').trim(), err: (run.stderr || '').trim()};
}
const containerExists = (name) => sh(['ps', '-a', '--filter', `name=^/${name}$`, '--format', '{{.Names}}']).out !== '';
async function connectWhenReady(config) {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    const client = new pg.Client(config);
    try { await client.connect(); return client; } catch { await client.end().catch(() => {}); await new Promise((wait) => setTimeout(wait, 500)); }
  }
  throw new Error('手元の PostgreSQL が起動しない');
}
const decode = (bytes) => {
  try { return new TextDecoder('utf-8', {fatal: true}).decode(bytes); } catch { return new TextDecoder('shift_jis').decode(bytes); }
};
// ps1 を代表と同じ形で流す。接続の環境変数は渡さない。input は Read-Host への答え
function runPs1(script, args, {input = ''} = {}) {
  return new Promise((done) => {
    const env = {...process.env};
    for (const name of ['PGHOST', 'PGPORT', 'PGUSER', 'PGPASSWORD', 'PGDATABASE', 'PGSSLMODE', 'POSTGRES_PASSWORD']) delete env[name];
    const child = spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script, ...args], {env, windowsHide: true});
    const out = [], err = [];
    child.stdout.on('data', (chunk) => out.push(chunk));
    child.stderr.on('data', (chunk) => err.push(chunk));
    child.on('close', (code) => {
      const stdout = decode(Buffer.concat(out)).replace(/\r\n/g, '\n');
      const stderr = decode(Buffer.concat(err)).replace(/\r\n/g, '\n');
      done({code, stdout, stderr, output: `${stdout}\n${stderr}`});
    });
    child.stdin.end(input);
  });
}

// 架空の行と原本2つを入れた DB を、練習 F の作業フォルダと同じ形に書き出す
async function writeGeneration(client, root, stamp) {
  await client.query("INSERT INTO organizations (code, name) VALUES ('DEMO-G', '架空の練習Gの組織')");
  const org = (await client.query("SELECT id FROM organizations WHERE code = 'DEMO-G'")).rows[0].id;
  await client.query("INSERT INTO users (email, display_name) VALUES ('g-drill@example.invalid', '架空の練習Gの利用者')");
  const user = (await client.query("SELECT id FROM users WHERE email = 'g-drill@example.invalid'")).rows[0].id;
  await client.query("INSERT INTO memberships (org_id, user_id, role, active) VALUES ($1, $2, 'admin', 1)", [org, user]);
  for (let i = 1; i <= 12; i += 1) await client.query('INSERT INTO projects (org_id, code, title, budget_yen) VALUES ($1, $2, $3, $4)', [org, `G-${i}`, `架空の企画 ${i}`, 1000000 * i + 7]);
  const artifactDir = join(root, '..', `artifacts-src-${stamp}`);
  mkdirSync(artifactDir, {recursive: true});
  const artifacts = directoryBucket(artifactDir);
  for (const index of [1, 2]) {
    const bytes = Buffer.from(Buffer.from(`架空の練習Gの原本 ${index}\n`.repeat(40)).toString('base64'), 'utf8');
    const hash = sha256(bytes);
    const key = `private/workbench/sha256/${hash.slice(0, 2)}/${hash}`;
    await artifacts.put(key, bytes);
    await client.query(`INSERT INTO expense_source_files (org_id, created_by, reason, file_name, media_type, byte_length, raw_sha256, original_base64)
      VALUES ($1, $2, $3, $4, 'text/plain', $5, $6, $7)`, [org, user, '架空の練習の原本', `fictional-g-${index}.txt`, 40, sha256(`fictional-g-raw-${index}`), `@r2:v1:${key}:${hash}:${bytes.length}`]);
  }
  const folder = join(root, `pg-F-${stamp}`);
  mkdirSync(folder, {recursive: true});
  const {manifestKey, manifest} = await exportPgDatabase({db: new PgDatabase(client), bucket: directoryBucket(folder), artifacts, runId: `fictional-g-${stamp.replace('-', '')}`});
  return {folder, manifestKey, manifest};
}

// 土台（ファイルの中で1回だけ作る）: 起点（0011）の世代と、最後の移行の版の世代
let fixturePromise = null;
function fixture() {
  fixturePromise ??= (async () => {
    const dir = mkdtempSync(join(TMP, 'pg-migrate ps1 '));
    cleanups.push(() => rmSync(dir, {recursive: true, force: true}));
    const name = `on-migrate-test-src-${process.pid}`;
    sh(['rm', '-f', '-v', name]);
    const started = sh(['run', '-d', '--name', name, '-e', `POSTGRES_PASSWORD=${FAKE_PASSWORD}`, '-p', '127.0.0.1::5432', IMAGE]);
    assert.equal(started.code, 0, started.err);
    cleanups.push(() => { sh(['rm', '-f', '-v', name]); });
    const port = Number(/:(\d+)\s*$/.exec(sh(['port', name, '5432/tcp']).out.split('\n')[0])[1]);
    const config = {host: '127.0.0.1', port, user: 'postgres', password: FAKE_PASSWORD, database: 'postgres'};
    const admin = await connectWhenReady(config);
    cleanups.push(() => admin.end().catch(() => {}));
    const generations = {};
    for (const [label, sql, stamp] of [['base', convertDelta({from: BASE}).base.sql, '20261011-000001'], ['last', readFileSync(join(APP, 'pg', 'schema.sql'), 'utf8'), '20261011-000002']]) {
      await admin.query(`CREATE DATABASE gen_${label}`);
      const client = await connectWhenReady({...config, database: `gen_${label}`});
      cleanups.push(() => client.end().catch(() => {}));
      await client.query(sql);
      const root = join(dir, label, 'ondrill');
      mkdirSync(root, {recursive: true});
      generations[label] = {root, ...(await writeGeneration(client, root, stamp))};
    }
    return {dir, ...generations};
  })();
  return fixturePromise;
}

test('残ったコンテナの片付けは、試験の名前の形で pid のプロセスがもう無いものだけを消し、生きている試験と形の違うコンテナは消さない', () => {
  const names = ['on-drill-test-src-111', 'on-drill-test-g-111-a', 'on-migrate-test-staging-222-345', 'on-drill-test-f-333', 'on-s14-pg', 'supabase_db_x', 'on-drill-pg-g-a', 'on-drill-test-src-abc'];
  const calls = [];
  const run = (args) => {
    calls.push(args.join(' '));
    return args[0] === 'ps' ? {status: 0, stdout: `${names.join('\n')}\n`} : {status: 0, stdout: ''};
  };
  const removed = removeStaleTestContainers({run, alive: (pid) => pid === 333});
  assert.deepEqual(removed, ['on-drill-test-src-111', 'on-drill-test-g-111-a', 'on-migrate-test-staging-222-345']);
  assert.deepEqual(calls.filter((c) => c.startsWith('rm ')), removed.map((name) => `rm -f -v ${name}`));
  assert.deepEqual(removeStaleTestContainers({run: () => ({status: 1, stdout: ''}), alive: () => false}), [], 'docker が応えなければ何もしない');
  assert.equal(TEST_CONTAINER.test('on-drill-test-g2-4242-b'), true);
});

test('pg-staging.ps1 は日次バックアップの02:58から03:15だけを避け、廃止した毎時の時間帯を避けない', {skip: powershell ? false : 'Windows PowerShell 5.1（powershell.exe）が無い環境（CI の WSL など）'}, () => {
  // ps1 の構文木から $exportSchedule と2つの関数だけを取り出して流す（ps1 の本体は流さない）
  const probe = String.raw`$ast = [System.Management.Automation.Language.Parser]::ParseFile('${STAGING_PS1.replaceAll("'", "''")}', [ref]$null, [ref]$null)
$schedule = @($ast.FindAll({ param($n) $n -is [System.Management.Automation.Language.AssignmentStatementAst] -and $n.Left.Extent.Text -eq '$exportSchedule' }, $false))
$functions = @($ast.FindAll({ param($n) $n -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -in @('Test-ExportBusy', 'Get-ExportScheduleText') }, $false))
Write-Output ('schedule=' + $schedule.Count)
. ([scriptblock]::Create($schedule[0].Extent.Text + [Environment]::NewLine + (($functions | ForEach-Object { $_.Extent.Text }) -join [Environment]::NewLine)))
foreach ($at in @('02:57', '02:58', '03:00', '03:15', '03:16', '10:28', '10:30', '10:45', '15:05', '00:00', '23:59')) { Write-Output ('daily ' + $at + '=' + (Test-ExportBusy ([DateTime]::ParseExact('2026-10-15 ' + $at, 'yyyy-MM-dd HH:mm', $null)))) }
Write-Output ('text=' + (Get-ExportScheduleText))`;
  const run = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', probe], {encoding: 'utf8', timeout: 60000});
  const lines = run.stdout.split(/\r?\n/).filter(Boolean);
  assert.deepEqual(lines.filter((l) => !l.startsWith('text=')), ['schedule=1',
    'daily 02:57=False', 'daily 02:58=True', 'daily 03:00=True', 'daily 03:15=True', 'daily 03:16=False',
    'daily 10:28=False', 'daily 10:30=False', 'daily 10:45=False', 'daily 15:05=False', 'daily 00:00=False', 'daily 23:59=False'], run.stderr);
});

const gDirs = (root) => (existsSync(root) ? readdirSync(root).filter((name) => /^pg-G-\d{8}-\d{6}$/.test(name)) : []);

test('練習 G: 練習 F の作業フォルダの世代を起点の版で戻し、差分を psql の -1 で当てて、新しい全体と定義・照合・新しい表の行の数が一致し、両方のコンテナを消す', {skip: SKIP, timeout: 900000}, async () => {
  const fx = await fixture();
  const name = `on-drill-test-g-${process.pid}`;
  const run = await runPs1(G_PS1, ['-WorkRoot', fx.base.root, '-ContainerName', name], {input: '\r\n'});
  assert.equal(run.code, 0, run.output.slice(-3000));
  assert.equal(containerExists(`${name}-a`), false, '差分を当てたコンテナが残らない');
  assert.equal(containerExists(`${name}-b`), false, '新しい全体のコンテナが残らない');
  const [work] = gDirs(fx.base.root);
  const result = JSON.parse(readFileSync(join(fx.base.root, work, 'pg-G-result.json'), 'utf8'));
  const rows = fx.base.manifest.tables.reduce((sum, table) => sum + Number(table.row_count), 0);
  assert.deepEqual([result.outcome, result.from, result.to, result.manifest_key, result.tables_before, result.rows_before, result.tables_after],
    ['ok', BASE, LAST, fx.base.manifestKey, fx.base.manifest.tables.length, rows, convertMigrations().fingerprint.expected.tables]);
  assert.equal(result.manifest_sha256, sha256(readFileSync(join(fx.base.folder, ...fx.base.manifestKey.split('/')))));
  assert.deepEqual([result.definitions_equal, result.definition_differences, result.catalog_ok, result.reconcile_equal, result.manifest_equal], [true, 0, true, true, true]);
  assert.deepEqual(result.new_tables, result.expected_new_tables);
  // 新しい表の行の数の正解は、起点から最後の移行までの差分が入れる数（後に積む移行で変わっても、この試験は直さなくてよい）
  assert.deepEqual(result.expected_new_tables, Object.fromEntries(convertDelta({from: BASE}).newTables.map(({table, rows}) => [table, rows])));
  for (const key of ['plan', 'restore', 'apply', 'apply_in_transaction', 'full_schema', 'compare', 'total']) assert.ok(Number.isInteger(result.durations_ms[key]) && result.durations_ms[key] >= 0, key);
  assert.match(run.stdout, /^判定: OK$/m);
  assert.doesNotMatch(run.output, /予期しない|NG {2}|PGPASSWORD|migrate-test-only/);
  assert.equal(existsSync(join(fx.base.folder, 'pg-daily')), true, '練習 F の作業フォルダは消さない');
});

test('練習 G: 世代が最後の移行の版なら「当てるものが無い」で止まり、コンテナを作らない', {skip: SKIP, timeout: 600000}, async () => {
  const fx = await fixture();
  const name = `on-drill-test-g2-${process.pid}`;
  const run = await runPs1(G_PS1, ['-WorkRoot', fx.last.root, '-ContainerName', name]);
  assert.equal(run.code, 1, run.output.slice(-3000));
  assert.match(run.stdout, new RegExp(`^NG {2}当てるものが無い（世代の版の印は、この作業場の最後の移行 ${LAST} と同じ）$`, 'm'));
  assert.match(run.stdout, /^判定: NG$/m);
  assert.equal(containerExists(`${name}-a`), false);
  assert.equal(containerExists(`${name}-b`), false);
});

// pg-staging.ps1 の -LocalContainer（trust で立てた手元のコンテナ）。psql は docker exec で、起点の全体と架空の行を入れる
function startStagingSim(t) {
  const name = `on-migrate-test-staging-${process.pid}-${Math.floor(Math.random() * 1e6)}`;
  sh(['rm', '-f', '-v', name]);
  assert.equal(sh(['run', '-d', '--name', name, '-e', 'POSTGRES_HOST_AUTH_METHOD=trust', IMAGE]).code, 0);
  t.after(() => { sh(['rm', '-f', '-v', name]); });
  const psql = (args, input) => sh(['exec', '-i', name, 'psql', '-X', '-q', '-tA', '-v', 'ON_ERROR_STOP=1', '-U', 'postgres', '-d', 'postgres', ...args], {input});
  for (let attempt = 0; attempt < 120 && psql(['-c', 'SELECT 1']).code !== 0; attempt += 1) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 500);
  const loaded = psql(['-1', '-f', '-'], `${convertDelta({from: BASE}).base.sql}\nINSERT INTO organizations (code, name) VALUES ('DEMO-S', '架空の組織');\nINSERT INTO projects (org_id, code, title, budget_yen) SELECT id, 'S-1', '架空の企画', 4321000 FROM organizations WHERE code = 'DEMO-S';\n`);
  assert.equal(loaded.code, 0, loaded.err);
  const lastMigration = () => psql(['-c', 'SELECT last_migration FROM schema_source_fingerprint']).out;
  return {name, psql, lastMigration};
}
const staging = (sim, action, root) => runPs1(STAGING_PS1, ['-Action', action, '-LocalContainer', sim.name, ...(root ? ['-WorkRoot', root] : [])]);

test('pg-staging.ps1（-LocalContainer）: catalog は数を直書きせずに差分が当たっていないことを出し、予行は何も変えず、本番のあとの catalog は一致し、2回目は当てるものが無い', {skip: SKIP, timeout: 900000}, async (t) => {
  const sim = startStagingSim(t);
  const root = tempDir(t, 'pg-migrate-staging-');
  const before = await staging(sim, 'catalog');
  assert.equal(before.code, 1, before.output.slice(-2000));
  assert.match(before.stdout, new RegExp(`^fingerprint_ok: false（DB は ${BASE} の版。この作業場は ${LAST}。`, 'm'));
  assert.match(before.stdout, /^次の一手: 差分の移行が当たっていない（DB は .+ の版）。手順書13の手順10の予行（-Action migrate-dryrun）から流す/m);
  assert.match(before.stdout, /^catalog_ok: true/m);
  const dry = await staging(sim, 'migrate-dryrun', root);
  assert.equal(dry.code, 0, dry.output.slice(-3000));
  assert.match(dry.stdout, /^判定: OK（予行。全部を流してから ROLLBACK したので、何も変えていない）$/m);
  assert.equal(sim.lastMigration(), BASE, '予行のあとは起点のまま');
  assert.equal(sim.psql(['-c', "SELECT count(*) FROM pg_class WHERE relname = 'earning_types'"]).out, '0', '予行で作った表は残らない');
  const applied = await staging(sim, 'migrate', root);
  assert.equal(applied.code, 0, applied.output.slice(-3000));
  assert.equal(sim.lastMigration(), LAST);
  const results = readdirSync(root).filter((n) => /^pg-migrate-/.test(n)).map((n) => JSON.parse(readFileSync(join(root, n, 'pg-migrate-result.json'), 'utf8')));
  const done = results.find((r) => r.action === 'migrate');
  assert.deepEqual([done.outcome, done.from, done.to, done.reconcile_equal, done.reconcile_differences], ['ok', BASE, LAST, true, 0]);
  assert.deepEqual(done.new_tables, done.expected_new_tables);
  const afterCatalog = await staging(sim, 'catalog');
  assert.equal(afterCatalog.code, 0, afterCatalog.output.slice(-2000));
  assert.match(afterCatalog.stdout, /^fingerprint_ok: true/m);
  assert.match(afterCatalog.stdout, /^判定: OK$/m);
  const again = await staging(sim, 'migrate', root);
  assert.equal(again.code, 0, again.output.slice(-2000));
  assert.match(again.stdout, /^判定: OK（当てるものが無い。何も変えていない）$/m);
  for (const run of [before, dry, applied, afterCatalog, again]) assert.doesNotMatch(run.output, /予期しない/);
});

test('pg-staging.ps1（-LocalContainer）: 版の印がずれた DB は base_mismatch の案内で、別の接続が表を押さえているあいだは 55P03 の案内で止まり、何も変わらない', {skip: SKIP, timeout: 900000}, async (t) => {
  const root = tempDir(t, 'pg-migrate-staging-ng-');
  const shifted = startStagingSim(t);
  shifted.psql(['-c', "UPDATE schema_source_fingerprint SET ddl_sha256 = repeat('0', 64)"]);
  const mismatch = await staging(shifted, 'migrate-dryrun', root);
  assert.equal(mismatch.code, 1, mismatch.output.slice(-2000));
  assert.match(mismatch.stdout, /^NG {2}DB の版の印の12の列が、この作業場の起点の変換と合わない$/m);
  assert.match(mismatch.stdout, /^次の一手: 何も変えていない。/m);
  // 止まったときの結果の JSON の行は、NG・次の一手・判定のあとに出る
  const order = ['NG  ', '次の一手: ', '判定: NG', '結果の JSON（数値だけ）: '].map((head) => mismatch.stdout.split('\n').findIndex((line) => line.startsWith(head)));
  assert.ok(order.every((at, k) => at >= 0 && (k === 0 || at > order[k - 1])), mismatch.stdout);
  const locked = startStagingSim(t);
  // 別の接続が projects を SHARE で押さえる（ALTER TABLE の ACCESS EXCLUSIVE を待たせる）
  const holder = spawn('docker', ['exec', locked.name, 'psql', '-X', '-q', '-U', 'postgres', '-d', 'postgres', '-c', 'BEGIN; LOCK TABLE projects IN SHARE MODE; SELECT pg_sleep(30); COMMIT;'], {windowsHide: true});
  const holderDone = new Promise((done) => holder.on('close', done));
  for (let attempt = 0; attempt < 40; attempt += 1) {
    if (locked.psql(['-c', "SELECT count(*) FROM pg_locks l JOIN pg_class c ON c.oid = l.relation WHERE c.relname = 'projects' AND l.mode = 'ShareLock' AND l.granted"]).out === '1') break;
    await new Promise((wait) => setTimeout(wait, 250));
  }
  const waited = await staging(locked, 'migrate', root);
  assert.equal(waited.code, 1, waited.output.slice(-2000));
  assert.match(waited.stdout, /^NG {2}差分の移行が 55P03 で止まった（本番）$/m);
  assert.match(waited.stdout, /^次の一手: ロック待ちで止まった/m);
  await holderDone;
  assert.equal(locked.lastMigration(), BASE, 'ロック待ちで止まったら起点のまま');
  assert.equal(locked.psql(['-c', "SELECT count(*) FROM pg_class WHERE relname = 'earning_types'"]).out, '0');
});
