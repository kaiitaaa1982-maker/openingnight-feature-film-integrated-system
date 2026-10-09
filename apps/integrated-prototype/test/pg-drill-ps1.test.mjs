// 代表が流す練習 F・E の1行の ps1（scripts/pg-drill-restore.ps1・scripts/pg-drill-pitr.ps1。PG 計画 段2の実測 S9・S10）の試験。
// Windows PowerShell 5.1 で、代表と同じ形（powershell.exe -NoProfile -ExecutionPolicy Bypass -File）で流す。
// ・土台: 試験が立てて消す手元の Docker の postgres:18.6-alpine に pg/schema.sql と pg/local-seed.sql と、R2 へ逃がした値（架空の原本2つ）を
//   指す行を入れ、exportPgDatabase で手元のフォルダ（core の scripts/ops/pg-restore.mjs の directoryBucket）へ世代を書き出す
// ・F: -ArchiveDir でその世代から、ps1 が立てる別のコンテナへ戻し、件数と金額の一致・原本の指紋・区切りの時刻が pg-F-result.json に出て、
//   コンテナが残らない。版の違う schema.sql では schema_mismatch で止まり、版の案内を出す
// ・F: 取得の経路を偽の npx.cmd（R2 の代わりに同じフォルダから写し、引数と作業場所とアカウントを記録する）で流し、同じ1行で流し直すと
//   手元の同じ指紋のファイルを飛ばし、壊した・消したファイルだけを取り直す。-WhatIf は wrangler を呼ばず、--remote を含む引数を出す
// ・F: 取得の失敗（whoami の失敗・r2 object get の失敗と3回の取り直し）で案内を出して終了コード 1 で止まる。原本の確かめ（手順4）は、
//   pg-restore.mjs が通ったあとに複写を書き換える・消す・足す（偽の node.cmd が本物の node を呼んだあとに手を加える）と止まる。
//   思わぬ失敗では、値を含まない例外の型と ps1 の名前・行番号を出す。作業フォルダを消せないときは止めずに手で消す案内を出す
// ・E: -LocalTarget で、同じ世代を戻した手元の DB と照合が一致し、1件足した DB では不一致で止まり、24時間を過ぎた manifest では照合の前に止まる。
//   PlanetScale に向ける問いの流れは、-ManifestKey で manifest だけを偽の npx.cmd から取り、接続の値の前まで流して、戻す時刻と pscale の1行・
//   drill のブランチを消した時刻が残ること（Host の形が違えば3回まで尋ね直す。管で渡した入力ではパスワードを尋ねずに止まる。Enter だけを待つ問いに
//   pscale の行を貼ると尋ね直す。G1 の後に staging を使ったかの問いは Enter だけで進む）
// ・E: パスワード（-AsSecureString）から先は、管の入力では流せないので、隠した窓（Start-Process -WindowStyle Hidden。管の入力ではない画面）で
//   ps1 を & で呼び、Read-Host を同じ名前の偽の関数に置き換えて答える（runPs1Console）。psql の docker run は偽の docker.cmd が受け、渡された
//   接続の環境変数を記録し、同じ世代を戻した手元の DB から作った件数と金額の JSON を pitr.json に置く。これで、窓に残った PGPASSWORD を使わずに
//   尋ねること・照合が一致して F と E の作業フォルダを片づけること・復旧の時刻が違うときの作り直し・docker の 125 のやり直し・PITR を始めたときの
//   24時間の確かめ・途中で止まっても drill のブランチの消し方を出すこと（finally）を確かめる。PlanetScale の verify-full の接続そのものは通せない
// Cloudflare・PlanetScale には届かない。powershell.exe（Windows）・Docker・postgres:18.6-alpine の像が無い環境では理由をつけて skip する。
// DB のパスワードは試験だけの偽物。架空のデータだけを使う
import test, {after} from 'node:test';
import assert from 'node:assert/strict';
import {spawn, spawnSync} from 'node:child_process';
import {appendFileSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, unlinkSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname, join, resolve} from 'node:path';
import pg from 'pg';
import {PgDatabase} from '../src/data-platform/pg-db.mjs';
import {exportPgDatabase, sha256} from '../src/data-platform/pg-export-store.mjs';
import {restorePgDatabase} from '../src/data-platform/pg-restore-store.mjs';
import {directoryBucket} from '../../../scripts/ops/pg-restore.mjs';

const APP = resolve(import.meta.dirname, '..');
const F_PS1 = join(APP, 'scripts', 'pg-drill-restore.ps1');
const E_PS1 = join(APP, 'scripts', 'pg-drill-pitr.ps1');
const IMAGE = 'postgres:18.6-alpine';
const BUCKET = 'openingnight-integrated-demo-staging-pg-exports';
const ACCOUNT_ID = /"account_id"\s*:\s*"([0-9a-f]{32})"/.exec(readFileSync(join(APP, 'wrangler.cloud.jsonc'), 'utf8'))[1];
// 試験だけの偽物（秘密値ではない）。この試験で立てて消す手元の使い捨ての PostgreSQL にだけ使う
const FAKE_PASSWORD = 'drill-test-only-fake-password';
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
// 一時のフォルダは長い名前の形にし、名前に空白を入れる（代表の %USERPROFILE% は空白を含む。8.3 の短い名前のままだと
// Docker の bind mount が読めないことがある）
const TMP = realpathSync.native(tmpdir());

const powershell = process.platform === 'win32'
  && spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', '$PSVersionTable.PSVersion.Major'], {encoding: 'utf8', timeout: 60000}).stdout?.trim() === '5';
const docker = powershell && spawnSync('docker', ['version', '--format', '{{.Server.Version}}'], {encoding: 'utf8', timeout: 20000}).status === 0;
const image = docker && spawnSync('docker', ['image', 'inspect', '--format', '{{.Id}}', IMAGE], {encoding: 'utf8', timeout: 20000}).status === 0;
const SKIP = !powershell ? 'Windows PowerShell 5.1（powershell.exe）が無い環境（CI の WSL など）'
  : !docker ? 'Docker が無いか20秒のうちに応えない環境'
    : !image ? `${IMAGE} の像が手元に無い（docker pull ${IMAGE} のあとに流す）` : false;

const cleanups = [];
after(async () => { for (const step of cleanups.reverse()) await step(); });

function tempDir(t, prefix) {
  const dir = mkdtempSync(join(TMP, `${prefix} `));
  t.after(() => rmSync(dir, {recursive: true, force: true}));
  return dir;
}

function sh(args, timeout = 120000) {
  const run = spawnSync('docker', args, {encoding: 'utf8', timeout});
  return {code: run.status, out: (run.stdout || '').trim(), err: (run.stderr || '').trim()};
}

const containerExists = (name) => sh(['ps', '-a', '--filter', `name=^/${name}$`, '--format', '{{.Names}}']).out !== '';

async function connectWhenReady(config) {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    const client = new pg.Client(config);
    try {
      await client.connect();
      return client;
    } catch {
      await client.end().catch(() => {});
      await new Promise((wait) => setTimeout(wait, 500));
    }
  }
  throw new Error('手元の PostgreSQL が起動しない');
}

// 土台（ファイルの試験の中で1回だけ作る）: 書き出した世代のフォルダ・manifest・E 用に同じ世代を戻した DB
let fixturePromise = null;
function fixture() {
  fixturePromise ??= (async () => {
    const dir = mkdtempSync(join(TMP, 'pg-drill ps1 '));
    cleanups.push(() => rmSync(dir, {recursive: true, force: true}));
    const name = `on-drill-test-src-${process.pid}`;
    sh(['rm', '-f', '-v', name]);
    const started = sh(['run', '-d', '--name', name, '-e', `POSTGRES_PASSWORD=${FAKE_PASSWORD}`, '-p', '127.0.0.1::5432', IMAGE]);
    assert.equal(started.code, 0, started.err);
    cleanups.push(() => { sh(['rm', '-f', '-v', name]); });
    const port = Number(/:(\d+)\s*$/.exec(sh(['port', name, '5432/tcp']).out.split('\n')[0])[1]);
    const config = {host: '127.0.0.1', port, user: 'postgres', password: FAKE_PASSWORD, database: 'postgres'};
    const source = await connectWhenReady(config);
    cleanups.push(() => source.end().catch(() => {}));
    const schemaSql = readFileSync(join(APP, 'pg', 'schema.sql'), 'utf8');
    await source.query(schemaSql);
    await source.query(readFileSync(join(APP, 'pg', 'local-seed.sql'), 'utf8'));
    // R2 へ逃がした値（架空の原本2つ）。行には印（@r2:v1:<キー>:<SHA-256>:<大きさ>）だけを書き、値は原本のフォルダに置く
    const artifactDir = join(dir, 'artifacts-src');
    mkdirSync(artifactDir);
    const artifacts = directoryBucket(artifactDir);
    for (const index of [1, 2]) {
      const bytes = Buffer.from(Buffer.from(`架空の練習用の原本 ${index}\n`.repeat(40)).toString('base64'), 'utf8');
      const hash = sha256(bytes);
      const key = `private/workbench/sha256/${hash.slice(0, 2)}/${hash}`;
      await artifacts.put(key, bytes);
      await source.query(`INSERT INTO expense_source_files (org_id, created_by, reason, file_name, media_type, byte_length, raw_sha256, original_base64)
        VALUES (1, 1, $1, $2, 'text/plain', $3, $4, $5)`, ['架空の練習の原本', `fictional-drill-${index}.txt`, 40, sha256(`fictional-raw-${index}`), `@r2:v1:${key}:${hash}:${bytes.length}`]);
    }
    const archive = join(dir, 'r2');
    mkdirSync(archive);
    const {manifestKey, manifest} = await exportPgDatabase({db: new PgDatabase(source), bucket: directoryBucket(archive), artifacts, runId: 'fictional-drill'});
    // E の手元の DB: 同じ世代を空の別の DB へ戻す
    await source.query('CREATE DATABASE drill_restored');
    const target = await connectWhenReady({...config, database: 'drill_restored'});
    cleanups.push(() => target.end().catch(() => {}));
    mkdirSync(join(dir, 'artifacts-e'));
    await restorePgDatabase({db: new PgDatabase(target), bucket: directoryBucket(archive), manifestKey, schemaSql, artifacts: directoryBucket(join(dir, 'artifacts-e'))});
    const objects = [...manifest.tables.flatMap((table) => table.parts), ...manifest.blobs];
    const rows = manifest.tables.reduce((sum, table) => sum + Number(table.row_count), 0);
    // 偽の docker が pitr.json に置く件数と金額の JSON（ps1 と同じく reconcile.sql の注釈と末尾の ; を外して json_agg で包み、同じ世代を戻した DB で読む）。
    // 照合が不一致の試験が DB に1件足す前に作る
    const reconcileSql = readFileSync(join(APP, 'pg', 'reconcile.sql'), 'utf8').replace(/^--[^\r\n]*/gm, '').trim().replace(/;+$/, '');
    const pitrJson = join(dir, 'pitr-from-restored.json');
    writeFileSync(pitrJson, JSON.stringify((await target.query(`SELECT json_agg(t) AS reconciled FROM (${reconcileSql}) t`)).rows[0].reconciled));
    return {dir, archive, manifestKey, manifest, manifestFile: join(archive, ...manifestKey.split('/')), objects, rows, port, target, pitrJson};
  })();
  return fixturePromise;
}

const decode = (bytes) => {
  try { return new TextDecoder('utf-8', {fatal: true}).decode(bytes); } catch { return new TextDecoder('shift_jis').decode(bytes); }
};

// ps1 を代表と同じ形（powershell -ExecutionPolicy Bypass -File …）で流す。input は Read-Host への答え。
// 接続の環境変数とアカウントは、env で渡したものだけにする
function runPs1(script, args, {env = {}, input = '', pathPrefix = null} = {}) {
  return new Promise((done) => {
    const merged = {...process.env};
    for (const name of ['PGHOST', 'PGPORT', 'PGUSER', 'PGPASSWORD', 'PGDATABASE', 'PGSSLMODE', 'POSTGRES_PASSWORD', 'CLOUDFLARE_ACCOUNT_ID']) delete merged[name];
    Object.assign(merged, env);
    if (pathPrefix) {
      const pathKey = Object.keys(merged).find((key) => key.toUpperCase() === 'PATH') || 'PATH';
      merged[pathKey] = `${pathPrefix};${merged[pathKey] ?? ''}`;
    }
    const child = spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script, ...args], {env: merged, windowsHide: true});
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

// 偽の wrangler（npx.cmd → node）。r2 object get は、R2 の代わりに書き出した世代のフォルダから写す（無いキーは wrangler と同じく空のファイルを残して 1）。
// 呼ばれた引数・作業場所・アカウントを1行ずつ記録する。FAKE_WHOAMI_FAIL があれば未ログイン（終了コード 1）、FAKE_R2_FAIL_KEY に合うキー
// （* は全部）は取れない（終了コード 1）
const FAKE_NPX = String.raw`import {appendFileSync, copyFileSync, existsSync, mkdirSync, writeFileSync} from 'node:fs';
import {dirname, join} from 'node:path';
const args = process.argv.slice(2);
appendFileSync(process.env.FAKE_NPX_LOG, JSON.stringify({args, cwd: process.cwd(), account: process.env.CLOUDFLARE_ACCOUNT_ID ?? null}) + '\n');
if (args[0] !== '--no-install' || args[1] !== 'wrangler') process.exit(9);
const cmd = args.slice(2);
if (cmd.join(' ') === 'whoami --json') {
  if (process.env.FAKE_WHOAMI_FAIL) {
    process.stdout.write('{"loggedIn":false}\n');
    process.exit(1);
  }
  process.stdout.write(JSON.stringify({loggedIn: true, email: 'fictional-user@example.invalid', accounts: [{name: 'fictional-account'}]}) + '\n');
  process.exit(0);
}
if (cmd[0] === 'r2' && cmd[1] === 'object' && cmd[2] === 'get') {
  const [objectPath, ...rest] = cmd.slice(3);
  const at = rest.indexOf('--file');
  if (!rest.includes('--remote') || at < 0) process.exit(8);
  const file = rest[at + 1];
  const slash = objectPath.indexOf('/');
  const bucket = objectPath.slice(0, slash), key = objectPath.slice(slash + 1);
  process.stdout.write('Downloading "' + key + '" from "' + bucket + '".\n');
  mkdirSync(dirname(file), {recursive: true});
  const source = join(process.env.FAKE_R2_DIR, ...key.split('/'));
  const failKey = process.env.FAKE_R2_FAIL_KEY;
  if (bucket !== process.env.FAKE_R2_BUCKET || !existsSync(source) || failKey === '*' || failKey === key) {
    writeFileSync(file, '');
    process.stderr.write('X [ERROR] The specified key does not exist.\n');
    process.exit(1);
  }
  copyFileSync(source, file);
  process.stdout.write('Download complete.\n');
  process.exit(0);
}
process.exit(6);
`;

function fakeNpx(t, r2Dir, extraEnv = {}) {
  const dir = tempDir(t, 'pg-drill-npx-');
  writeFileSync(join(dir, 'fake-npx.mjs'), FAKE_NPX);
  writeFileSync(join(dir, 'npx.cmd'), '@echo off\r\n"%FAKE_NPX_NODE%" "%~dp0fake-npx.mjs" %*\r\nexit /b %ERRORLEVEL%\r\n');
  const log = join(dir, 'calls.ndjson');
  writeFileSync(log, '');
  return {
    pathPrefix: dir,
    env: {FAKE_NPX_NODE: process.execPath, FAKE_NPX_LOG: log, FAKE_R2_DIR: r2Dir, FAKE_R2_BUCKET: BUCKET, ...extraEnv},
    // 前回までの記録を読み、空にする
    take() {
      const calls = readFileSync(log, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line));
      writeFileSync(log, '');
      return calls;
    },
  };
}

// 偽の node（node.cmd → 本物の node）。引数をそのまま本物の node に渡し、pg-restore.mjs が通った（終了コード 0）あとに、FAKE_TAMPER の
// とおり --artifacts の複写に手を加える（rewrite: 1つに1バイト足す・delete: 1つ消す・extra: 世代に無いファイルを1つ足す）
const FAKE_NODE = String.raw`import {spawnSync} from 'node:child_process';
import {appendFileSync, readdirSync, unlinkSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
const args = process.argv.slice(2);
const run = spawnSync(process.execPath, args, {stdio: 'inherit'});
const code = run.status ?? 1;
const at = args.indexOf('--artifacts');
if (code === 0 && at >= 0 && args.some((arg) => arg.endsWith('pg-restore.mjs'))) {
  const files = readdirSync(args[at + 1], {recursive: true, withFileTypes: true}).filter((entry) => entry.isFile())
    .map((entry) => join(entry.parentPath, entry.name)).sort();
  if (process.env.FAKE_TAMPER === 'rewrite') appendFileSync(files[0], 'x');
  if (process.env.FAKE_TAMPER === 'delete') unlinkSync(files[0]);
  if (process.env.FAKE_TAMPER === 'extra') writeFileSync(join(args[at + 1], 'fictional-extra.bin'), 'x');
}
process.exit(code);
`;

function fakeNode(t, tamper) {
  const dir = tempDir(t, 'pg-drill-node-');
  writeFileSync(join(dir, 'fake-node.mjs'), FAKE_NODE);
  writeFileSync(join(dir, 'node.cmd'), '@echo off\r\n"%FAKE_NODE_REAL%" "%~dp0fake-node.mjs" %*\r\nexit /b %ERRORLEVEL%\r\n');
  return {pathPrefix: dir, env: {FAKE_NODE_REAL: process.execPath, FAKE_TAMPER: tamper}};
}

// 偽の docker（docker.cmd → node）。version は応える。run は FAKE_DOCKER_RUN_CODES（, 区切り。n 回目の run の終了コード。足りなければ最後の値）で
// 終わり、0 のときは bind mount の元のフォルダに FAKE_PITR_JSON を pitr.json として置く（psql の代わり）。run の引数と、そのとき渡っていた
// 接続の環境変数（docker へは名前だけを渡すので、docker の側で見える値）を1行ずつ記録する
const FAKE_DOCKER = String.raw`import {appendFileSync, copyFileSync, existsSync, readFileSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
const args = process.argv.slice(2);
if (args[0] === 'version') { process.stdout.write('29.0.0-fictional\n'); process.exit(0); }
if (args[0] !== 'run') process.exit(64);
const state = process.env.FAKE_DOCKER_STATE;
const runs = existsSync(state) ? Number(readFileSync(state, 'utf8')) : 0;
writeFileSync(state, String(runs + 1));
const env = Object.fromEntries(['PGHOST', 'PGPORT', 'PGUSER', 'PGPASSWORD', 'PGDATABASE', 'PGSSLMODE'].map((name) => [name, process.env[name] ?? null]));
appendFileSync(process.env.FAKE_DOCKER_LOG, JSON.stringify({args, env}) + '\n');
const codes = (process.env.FAKE_DOCKER_RUN_CODES || '0').split(',').map(Number);
const code = codes[Math.min(runs, codes.length - 1)];
if (code !== 0) { process.stderr.write('docker: fictional failure.\n'); process.exit(code); }
const mount = args[args.indexOf('--mount') + 1];
copyFileSync(process.env.FAKE_PITR_JSON, join(/(?:^|,)source=([^,]+)/.exec(mount)[1], 'pitr.json'));
process.exit(0);
`;

function fakeDocker(t, pitrJson, runCodes = '0') {
  const dir = tempDir(t, 'pg-drill-docker-');
  writeFileSync(join(dir, 'fake-docker.mjs'), FAKE_DOCKER);
  writeFileSync(join(dir, 'docker.cmd'), '@echo off\r\n"%FAKE_DOCKER_NODE%" "%~dp0fake-docker.mjs" %*\r\nexit /b %ERRORLEVEL%\r\n');
  const log = join(dir, 'runs.ndjson');
  writeFileSync(log, '');
  return {
    pathPrefix: dir,
    env: {FAKE_DOCKER_NODE: process.execPath, FAKE_DOCKER_LOG: log, FAKE_DOCKER_STATE: join(dir, 'state.txt'), FAKE_DOCKER_RUN_CODES: runCodes, FAKE_PITR_JSON: pitrJson},
    runs: () => readFileSync(log, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line)),
  };
}

// 画面の問いに答える形で ps1 を流す（パスワードの -AsSecureString は管の入力では流せないため）。隠した窓（Start-Process -WindowStyle Hidden。
// 入力は管でなく画面）の powershell.exe で、Read-Host を同じ名前の偽の関数に置き換えてから ps1 を & で呼ぶ。偽の Read-Host は answers を順に返し
// （尽きたら $null。管の入力が尽きたときと同じ）、問いの文と -AsSecureString かを記録する。sleepAt の文を含む問いでは sleepSeconds 秒待ってから、
// exitAt の文を含む問いでは答えずに exit 99（途中で止まったときの代わり。finally だけが流れる）。出力は *> でファイルへ（UTF-16）。
// *> はファイルへ書くとき窓の幅（120字）で Write-Host の行を折るので、窓の幅を広げてから呼ぶ（画面では折り返しの表示だけで、行は1つ）。
// 2つの ps1 は BOM なしで書くので ASCII だけにする（PS 5.1 は BOM の無い日本語を cp932 で読み、次の行まで壊れる）
const CONSOLE_OUTER = String.raw`param([string]$InnerPath, [string]$ConfigPath)
$argLine = '-NoProfile -ExecutionPolicy Bypass -File "' + $InnerPath + '" -ConfigPath "' + $ConfigPath + '"'
$child = Start-Process -FilePath 'powershell.exe' -ArgumentList $argLine -WindowStyle Hidden -Wait -PassThru
exit $child.ExitCode
`;
const CONSOLE_INNER = String.raw`param([string]$ConfigPath)
$global:fakeConfig = [IO.File]::ReadAllText($ConfigPath, [Text.Encoding]::UTF8) | ConvertFrom-Json
$global:fakeAnswers = New-Object 'System.Collections.Generic.Queue[string]'
foreach ($answer in @($global:fakeConfig.answers)) { $global:fakeAnswers.Enqueue([string]$answer) }
function global:Read-Host {
    param([Parameter(Position = 0)]$Prompt, [switch]$AsSecureString)
    $entry = @{ prompt = [string]$Prompt; secure = [bool]$AsSecureString } | ConvertTo-Json -Compress
    [IO.File]::AppendAllText($global:fakeConfig.log, $entry + [Environment]::NewLine, (New-Object System.Text.UTF8Encoding($false)))
    if ($global:fakeConfig.exitAt -and ([string]$Prompt).Contains([string]$global:fakeConfig.exitAt)) { exit 99 }
    if ($global:fakeConfig.sleepAt -and ([string]$Prompt).Contains([string]$global:fakeConfig.sleepAt)) { Start-Sleep -Seconds ([int]$global:fakeConfig.sleepSeconds) }
    if ($global:fakeAnswers.Count -eq 0) { return $null }
    $next = $global:fakeAnswers.Dequeue()
    if ($AsSecureString) { return (ConvertTo-SecureString $next -AsPlainText -Force) }
    return $next
}
$splat = @{}
foreach ($property in $global:fakeConfig.params.PSObject.Properties) { $splat[$property.Name] = $property.Value }
$targetPath = [string]$global:fakeConfig.target
$outPath = [string]$global:fakeConfig.out
$Host.UI.RawUI.BufferSize = New-Object System.Management.Automation.Host.Size(4096, $Host.UI.RawUI.BufferSize.Height)
& $targetPath @splat *> $outPath
exit $LASTEXITCODE
`;

function runPs1Console(t, script, params, {answers = [], env = {}, pathPrefix = [], sleepAt = null, sleepSeconds = 0, exitAt = null} = {}) {
  const dir = tempDir(t, 'pg-drill-console-');
  const files = {outer: join(dir, 'outer.ps1'), inner: join(dir, 'inner.ps1'), config: join(dir, 'config.json'), log: join(dir, 'prompts.ndjson'), out: join(dir, 'out.txt')};
  assert.match(CONSOLE_OUTER + CONSOLE_INNER, /^[\x00-\x7f]*$/, '試験の道具の ps1 は ASCII だけ（BOM なしで書くため）');
  writeFileSync(files.outer, CONSOLE_OUTER);
  writeFileSync(files.inner, CONSOLE_INNER);
  writeFileSync(files.log, '');
  writeFileSync(files.config, JSON.stringify({target: script, params, answers, log: files.log, out: files.out, sleepAt, sleepSeconds, exitAt}));
  return new Promise((done) => {
    const merged = {...process.env};
    for (const name of ['PGHOST', 'PGPORT', 'PGUSER', 'PGPASSWORD', 'PGDATABASE', 'PGSSLMODE', 'POSTGRES_PASSWORD', 'CLOUDFLARE_ACCOUNT_ID']) delete merged[name];
    Object.assign(merged, env);
    const pathKey = Object.keys(merged).find((key) => key.toUpperCase() === 'PATH') || 'PATH';
    merged[pathKey] = [...pathPrefix, merged[pathKey] ?? ''].join(';');
    const child = spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', files.outer, '-InnerPath', files.inner, '-ConfigPath', files.config],
      {env: merged, windowsHide: true, stdio: 'ignore'});
    child.on('close', (code) => {
      const stdout = existsSync(files.out) ? readFileSync(files.out).toString('utf16le').replace(/^﻿/, '').replace(/\r\n/g, '\n') : '';
      const prompts = readFileSync(files.log, 'utf8').split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
      done({code, stdout, output: stdout, prompts});
    });
  });
}

const workDirs = (root) => (existsSync(root) ? readdirSync(root).filter((name) => /^pg-F-\d{8}-\d{6}$/.test(name)) : []);
const readResult = (path) => JSON.parse(readFileSync(path, 'utf8'));
// manifest の snapshot_at（PostgreSQL の「2026-10-09 18:00:01.234567+00」）を、ps1 が出す ISO（ミリ秒まで・UTC）にする
const isoOf = (pgText) => new Date(pgText.replace(' ', 'T').replace(/\+00$/, 'Z')).toISOString();

function assertTimes(result, names) {
  for (const name of names) assert.match(String(result.times_utc[name]), ISO, name);
}

function assertRestoredResult(result, fx) {
  assert.equal(result.drill, 'F');
  assert.equal(result.outcome, 'ok');
  assert.equal(result.manifest_key, fx.manifestKey);
  assert.equal(result.manifest_sha256, sha256(readFileSync(fx.manifestFile)));
  assert.equal(result.snapshot_at_utc, isoOf(fx.manifest.snapshot_at));
  assert.equal(result.tables, fx.manifest.tables.length);
  assert.equal(result.rows, fx.rows);
  assert.equal(result.blobs, 2);
  assert.equal(result.blob_fingerprints_match, true);
  assert.equal(result.reconcile_equal, true);
  assert.equal(result.differences, 0);
  assert.equal(result.objects.total, fx.objects.length);
  assert.equal(result.objects.blobs, 2);
  assert.equal(result.objects.parts, fx.objects.length - 2);
  assert.equal(result.objects.bytes, fx.objects.reduce((sum, object) => sum + object.bytes, 0));
  assertTimes(result, ['acquire_started', 'acquire_finished', 'target_ready', 'restore_finished', 'blobs_checked', 'reconcile_finished']);
  const order = ['acquire_started', 'acquire_finished', 'target_ready', 'restore_finished', 'blobs_checked', 'reconcile_finished'].map((name) => Date.parse(result.times_utc[name]));
  assert.deepEqual(order, [...order].sort((a, b) => a - b), '区切りの時刻は順に並ぶ');
  for (const name of ['acquire', 'target', 'restore', 'blobs', 'reconcile', 'total']) {
    assert.equal(Number.isInteger(result.durations_ms[name]) && result.durations_ms[name] >= 0, true, name);
  }
  // 行の値（架空の原本の文・取引先の名前）・接続値は JSON に出さない
  assert.doesNotMatch(JSON.stringify(result), /架空|fictional-drill-|password|127\.0\.0\.1/i);
}

test('F: -ArchiveDir の世代を ps1 が立てたコンテナへ戻し、件数と金額・原本の指紋・区切りの時刻を出して、コンテナを残さない', {skip: SKIP, timeout: 600000}, async (t) => {
  const fx = await fixture();
  const root = join(tempDir(t, 'pg-drill-f-'), 'ondrill');
  const fake = fakeNpx(t, fx.archive);
  const name = `on-drill-test-f-${process.pid}`;
  const run = await runPs1(F_PS1, ['-ArchiveDir', fx.archive, '-ManifestKey', fx.manifestKey, '-WorkRoot', root, '-ContainerName', name],
    {env: fake.env, pathPrefix: fake.pathPrefix, input: '\r\n'});
  assert.equal(run.code, 0, run.output.slice(-3000));
  assert.deepEqual(fake.take(), [], '-ArchiveDir では wrangler を呼ばない');
  assert.equal(containerExists(name), false, '戻し先のコンテナが残らない');
  const [work] = workDirs(root);
  const result = readResult(join(root, work, 'pg-F-result.json'));
  assertRestoredResult(result, fx);
  assert.equal(result.mode, 'archive-dir');
  assert.deepEqual([result.objects.fetched, result.objects.skipped], [0, fx.objects.length]);
  // 原本の複写は manifest の blobs と同じ中身（キーの名前の指紋と一致）
  for (const blob of fx.manifest.blobs) {
    assert.equal(sha256(readFileSync(join(root, work, 'artifacts', ...blob.target.split('/')))), blob.sha256);
  }
  assert.match(run.stdout, /^判定: OK$/m);
  assert.match(run.stdout, /^OK {2}照合: 一致/m);
  assert.match(run.stdout, /pg-drill-pitr\.ps1" -ManifestFile "/, '練習 E の1行を出す');
  assert.doesNotMatch(run.output, /予期しない|NG {2}/);
});

test('F: 取得の経路（偽の npx.cmd）で全部を取り、同じ1行で流し直すと同じ指紋のファイルを飛ばし、壊した・消したファイルだけを取り直す', {skip: SKIP, timeout: 900000}, async (t) => {
  const fx = await fixture();
  const root = join(tempDir(t, 'pg-drill-f-'), 'ondrill');
  const fake = fakeNpx(t, fx.archive);
  const name = `on-drill-test-f-${process.pid}`;
  const args = ['-ManifestKey', fx.manifestKey, '-WorkRoot', root, '-ContainerName', name];
  const options = {env: fake.env, pathPrefix: fake.pathPrefix};

  const first = await runPs1(F_PS1, args, {...options, input: '\r\n'});
  assert.equal(first.code, 0, first.output.slice(-3000));
  const [work] = workDirs(root);
  const workPath = join(root, work);
  const calls = fake.take();
  for (const call of calls) {
    assert.equal(resolve(call.cwd).toLowerCase(), APP.toLowerCase(), 'apps/integrated-prototype から呼ぶ');
    assert.equal(call.account, ACCOUNT_ID, 'アカウントは wrangler.cloud.jsonc の account_id で渡す');
  }
  const commands = calls.map((call) => call.args.slice(2));
  assert.deepEqual(commands[0], ['whoami', '--json']);
  const fileOf = (key) => join(workPath, ...key.split('/'));
  assert.deepEqual(commands.slice(1), [fx.manifestKey, ...fx.objects.map((object) => object.key)]
    .map((key) => ['r2', 'object', 'get', `${BUCKET}/${key}`, '--remote', '--file', fileOf(key)]));
  const firstResult = readResult(join(workPath, 'pg-F-result.json'));
  assertRestoredResult(firstResult, fx);
  assert.equal(firstResult.mode, 'r2');
  assert.deepEqual([firstResult.objects.fetched, firstResult.objects.skipped], [fx.objects.length, 0]);
  assert.doesNotMatch(first.output, /fictional-user@example\.invalid|fictional-account|Download complete/, 'wrangler の出力を画面に出さない');

  // 同じ1行（前回の作業フォルダの続きを使う → 作業フォルダを残す）: 全部が手元にあるので wrangler を呼ばない
  const second = await runPs1(F_PS1, args, {...options, input: '\r\n\r\n'});
  assert.equal(second.code, 0, second.output.slice(-3000));
  assert.deepEqual(fake.take(), []);
  assert.deepEqual(workDirs(root), [work], '前回の作業フォルダを使う');
  const secondResult = readResult(join(workPath, 'pg-F-result.json'));
  assertRestoredResult(secondResult, fx);
  assert.deepEqual([secondResult.objects.fetched, secondResult.objects.skipped], [0, fx.objects.length]);

  // 1つを壊し（1バイト足す）、1つを消す → その2つだけを取り直す。最後に yes で作業フォルダを消す（結果の JSON は根へ写る）
  const broken = fx.objects[0], missing = fx.manifest.blobs[0];
  appendFileSync(fileOf(broken.key), 'x');
  unlinkSync(fileOf(missing.key));
  const third = await runPs1(F_PS1, args, {...options, input: '\r\nyes\r\n'});
  assert.equal(third.code, 0, third.output.slice(-3000));
  assert.deepEqual(fake.take().map((call) => call.args.slice(2)), [
    ['whoami', '--json'],
    ['r2', 'object', 'get', `${BUCKET}/${broken.key}`, '--remote', '--file', fileOf(broken.key)],
    ['r2', 'object', 'get', `${BUCKET}/${missing.key}`, '--remote', '--file', fileOf(missing.key)],
  ]);
  assert.equal(existsSync(workPath), false, 'yes で作業フォルダを消す');
  assert.deepEqual(readdirSync(root), [`${work}-result.json`], '根には結果の JSON だけが残る');
  const thirdResult = readResult(join(root, `${work}-result.json`));
  assertRestoredResult(thirdResult, fx);
  assert.deepEqual([thirdResult.objects.fetched, thirdResult.objects.skipped], [2, fx.objects.length - 2]);
  assert.equal(containerExists(name), false);
});

test('F: -WhatIf は wrangler・Docker を呼ばずフォルダも作らず、--remote を含む wrangler の引数を出す', {skip: SKIP, timeout: 300000}, async (t) => {
  const fx = await fixture();
  const root = join(tempDir(t, 'pg-drill-f-'), 'ondrill');
  const fake = fakeNpx(t, fx.archive);
  const plain = await runPs1(F_PS1, ['-WhatIf', '-ManifestKey', fx.manifestKey, '-WorkRoot', root], {env: fake.env, pathPrefix: fake.pathPrefix});
  assert.equal(plain.code, 0, plain.output.slice(-3000));
  assert.deepEqual(fake.take(), []);
  assert.equal(existsSync(root), false, '作業フォルダを作らない');
  const lines = plain.stdout.trim().split('\n');
  assert.ok(lines.some((line) => line.trim() === 'npx.cmd --no-install wrangler whoami --json'));
  const escape = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const getLine = (key) => new RegExp(`npx\\.cmd --no-install wrangler r2 object get ${escape(`${BUCKET}/${key}`)} --remote --file "?${escape(root)}\\\\pg-F-\\d{8}-\\d{6}\\\\${escape(key.replaceAll('/', '\\'))}"?$`);
  assert.ok(lines.some((line) => getLine(fx.manifestKey).test(line)), plain.stdout);
  assert.equal(lines.at(-1), '判定: 予行のみ（何も変えていない）');

  // -ArchiveDir も付けると、その世代の parts と blobs の全部の引数を出す
  const listed = await runPs1(F_PS1, ['-WhatIf', '-ManifestKey', fx.manifestKey, '-WorkRoot', root, '-ArchiveDir', fx.archive], {env: fake.env, pathPrefix: fake.pathPrefix});
  assert.equal(listed.code, 0, listed.output.slice(-3000));
  for (const object of fx.objects) assert.ok(listed.stdout.trim().split('\n').some((line) => getLine(object.key).test(line)), object.key);
  assert.deepEqual(fake.take(), []);
  assert.equal(existsSync(root), false);
});

test('F: 書き出したときと版の違う schema.sql では schema_mismatch で止まり、版の案内を出して、コンテナを残さない', {skip: SKIP, timeout: 600000}, async (t) => {
  const fx = await fixture();
  const dir = tempDir(t, 'pg-drill-f-');
  const root = join(dir, 'ondrill');
  const otherSchema = join(dir, 'schema-other-version.sql');
  writeFileSync(otherSchema, `${readFileSync(join(APP, 'pg', 'schema.sql'), 'utf8')}\nUPDATE schema_source_fingerprint SET ddl_sha256 = 'fictional-other-version';\n`);
  const name = `on-drill-test-f-${process.pid}`;
  const run = await runPs1(F_PS1, ['-ArchiveDir', fx.archive, '-ManifestKey', fx.manifestKey, '-WorkRoot', root, '-ContainerName', name, '-SchemaFile', otherSchema]);
  assert.equal(run.code, 1, run.output.slice(-3000));
  assert.match(run.stdout, /^NG {2}DB の戻しが schema_mismatch で止まった。/m);
  assert.match(run.stdout, new RegExp(`最後の移行 ${fx.manifest.schema.last_migration}・ddl_sha256 の先頭 ${fx.manifest.schema.ddl_sha256.slice(0, 12)}`));
  assert.match(run.stdout, /^次の一手: 書き出したときの main の版の schema\.sql が要る。取り違えて戻さない。/m);
  assert.match(run.stdout, /^判定: NG$/m);
  assert.equal(containerExists(name), false);
  const [work] = workDirs(root);
  const result = readResult(join(root, work, 'pg-F-result.json'));
  assert.equal(result.outcome, 'ng');
  assert.equal(result.reconcile_equal, null);
  assertTimes(result, ['acquire_started', 'acquire_finished', 'target_ready', 'restore_finished']);
});

test('F: pg-restore.mjs が通ったあとに原本の複写を書き換える・消す・足すと、原本の確かめ（手順4）で止まり、コンテナを残さない', {skip: SKIP, timeout: 900000}, async (t) => {
  const fx = await fixture();
  const name = `on-drill-test-f-${process.pid}`;
  const blobTarget = String.raw`private/workbench/sha256/[0-9a-f]{2}/[0-9a-f]{64}`;
  const cases = [
    ['rewrite', new RegExp(`^NG {2}原本の指紋が manifest と違う: ${blobTarget}$`, 'm')],
    ['delete', new RegExp(`^NG {2}原本の複写が無い: ${blobTarget}$`, 'm')],
    ['extra', /^NG {2}原本の複写の数（3）が manifest の blobs（2）と違う$/m],
  ];
  for (const [tamper, expected] of cases) {
    const root = join(tempDir(t, 'pg-drill-f-'), 'ondrill');
    const node = fakeNode(t, tamper);
    const run = await runPs1(F_PS1, ['-ArchiveDir', fx.archive, '-ManifestKey', fx.manifestKey, '-WorkRoot', root, '-ContainerName', name],
      {env: node.env, pathPrefix: node.pathPrefix});
    assert.equal(run.code, 1, `${tamper}: ${run.output.slice(-3000)}`);
    assert.match(run.stdout, /^OK {2}DB の戻し: /m, `${tamper}: pg-restore.mjs は通っている`);
    assert.match(run.stdout, expected, tamper);
    assert.match(run.stdout, /^判定: NG$/m);
    assert.doesNotMatch(run.stdout, /^OK {2}原本: /m);
    assert.equal(containerExists(name), false, `${tamper}: コンテナが残らない`);
    const result = readResult(join(root, workDirs(root)[0], 'pg-F-result.json'));
    assert.equal(result.outcome, 'ng');
    assert.equal(result.blob_fingerprints_match, null);
    assert.equal(result.reconcile_equal, null);
  }
});

test('F: 取得の失敗（未ログイン・manifest も parts も3回取り直して取れない）では、案内を出して終了コード 1 で止まる', {skip: SKIP, timeout: 600000}, async (t) => {
  const fx = await fixture();
  const name = `on-drill-test-f-${process.pid}`;
  const runWith = async (extraEnv) => {
    const root = join(tempDir(t, 'pg-drill-f-'), 'ondrill');
    const fake = fakeNpx(t, fx.archive, extraEnv);
    const run = await runPs1(F_PS1, ['-ManifestKey', fx.manifestKey, '-WorkRoot', root, '-ContainerName', name], {env: fake.env, pathPrefix: fake.pathPrefix});
    const commands = fake.take().map((call) => call.args.slice(2));
    assert.equal(run.code, 1, run.output.slice(-3000));
    assert.match(run.stdout, /^判定: NG$/m);
    assert.equal(containerExists(name), false, '戻し先を作る前に止まる');
    return {run, commands, work: join(root, workDirs(root)[0])};
  };
  const getOf = (key, work) => ['r2', 'object', 'get', `${BUCKET}/${key}`, '--remote', '--file', join(work, ...key.split('/'))];

  // 未ログイン: whoami で止まり、r2 object get を呼ばない
  const loggedOut = await runWith({FAKE_WHOAMI_FAIL: '1'});
  assert.match(loggedOut.run.stdout, /^NG {2}wrangler にログインしていない$/m);
  assert.match(loggedOut.run.stdout, /^次の一手: apps\\integrated-prototype で npx\.cmd --no-install wrangler login を流してから、同じ1行を流し直す/m);
  assert.deepEqual(loggedOut.commands, [['whoami', '--json']]);

  // manifest が取れない: 3回取り直してから止まり、取れなかった manifest を残さない
  const noManifest = await runWith({FAKE_R2_FAIL_KEY: '*'});
  assert.match(noManifest.run.stdout, /^NG {2}manifest を取れなかった（キーが無いか、R2 に届かない）$/m);
  assert.deepEqual(noManifest.commands, [['whoami', '--json'], ...Array(3).fill(getOf(fx.manifestKey, noManifest.work))]);
  assert.equal(existsSync(join(noManifest.work, ...fx.manifestKey.split('/'))), false);

  // parts の1つが取れない: そのキーを3回取り直してから止まり、それまでに取れた分は残す（同じ1行で続きから取れる）
  const [gotten, failing] = fx.objects;
  const onePart = await runWith({FAKE_R2_FAIL_KEY: failing.key});
  assert.match(onePart.run.stdout, new RegExp(`^NG {2}取れなかった: ${failing.key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'm'));
  assert.match(onePart.run.stdout, /^次の一手: R2 に届くか（ネットにつながっているか）を確かめてから、同じ1行を流し直す（取れた分は飛ばして続きから取る）$/m);
  assert.deepEqual(onePart.commands, [['whoami', '--json'], getOf(fx.manifestKey, onePart.work), getOf(gotten.key, onePart.work), ...Array(3).fill(getOf(failing.key, onePart.work))]);
  assert.equal(sha256(readFileSync(join(onePart.work, ...gotten.key.split('/')))), gotten.sha256, '取れた分は残す');
});

test('F: 思わぬ失敗では、例外の文を出さずに、例外の型と ps1 の名前・行番号を出す', {skip: SKIP, timeout: 120000}, async (t) => {
  const fx = await fixture();
  // Windows のパスに使えない文字（|）を含む作業フォルダの根 → .NET の Path.GetFullPath が ArgumentException を投げる（Stop-Drill でない失敗）
  const badRoot = join(tempDir(t, 'pg-drill-f-'), 'fictional|bad', 'ondrill');
  const run = await runPs1(F_PS1, ['-ArchiveDir', fx.archive, '-ManifestKey', fx.manifestKey, '-WorkRoot', badRoot]);
  assert.equal(run.code, 1, run.output.slice(-3000));
  assert.match(run.stdout, /^NG {2}予期しない失敗で止まった（System\.ArgumentException・pg-drill-common\.ps1 の \d+ 行目）$/m);
  assert.match(run.stdout, /^次の一手: この画面の出力を Claude に渡す/m);
  assert.match(run.stdout, /^判定: NG$/m);
  assert.doesNotMatch(run.output, /fictional\|bad|Illegal characters|無効な文字/, '例外の文とパスは出さない');
});

test('F・E の片付け: 作業フォルダのファイルを開いていて消せないときは、止めずに手で消す案内を出して $false を返し、閉じれば消せる', {skip: SKIP, timeout: 120000}, (t) => {
  const root = join(tempDir(t, 'pg-drill-rm-'), 'ondrill');
  const work = join(root, 'pg-F-20261009-000000');
  mkdirSync(join(work, 'sub'), {recursive: true});
  writeFileSync(join(work, 'pg-F-result.json'), '{"drill":"F"}');
  writeFileSync(join(work, 'sub', 'locked.bin'), 'x');
  const quote = (text) => `'${text.replaceAll("'", "''")}'`;
  const command = [
    "$ErrorActionPreference = 'Stop'",
    `. ${quote(join(APP, 'scripts', 'pg-drill-common.ps1'))}`,
    `$lock = [IO.File]::Open(${quote(join(work, 'sub', 'locked.bin'))}, 'Open', 'Read', 'None')`,
    `try { $first = Remove-DrillWorkDir ${quote(root)} ${quote(work)} 'pg-F-result.json'; Write-Host ('first=' + $first) } finally { $lock.Dispose() }`,
    `$second = Remove-DrillWorkDir ${quote(root)} ${quote(work)} 'pg-F-result.json'; Write-Host ('second=' + $second)`,
  ].join('\n');
  const run = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', command], {timeout: 60000});
  const stdout = decode(run.stdout).replace(/\r\n/g, '\n');
  assert.equal(run.status, 0, stdout + decode(run.stderr));
  assert.match(stdout, new RegExp(`^作業フォルダを消せなかった（練習の結果は OK）。エクスプローラーなどでこのフォルダを開いていれば閉じて、${work.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} を手で消す$`, 'm'));
  assert.match(stdout, /^first=False$/m);
  assert.match(stdout, /^second=True$/m);
  assert.equal(existsSync(work), false);
  assert.deepEqual(readdirSync(root), ['pg-F-20261009-000000-result.json']);
});

function localEnv(fx) {
  return {PGHOST: '127.0.0.1', PGPORT: String(fx.port), PGUSER: 'postgres', PGPASSWORD: FAKE_PASSWORD, PGDATABASE: 'drill_restored'};
}
const eWorkDir = (root) => join(root, readdirSync(root).find((name) => /^pg-E-\d{8}-\d{6}$/.test(name)));

test('E: -LocalTarget で、同じ世代を戻した手元の DB と G1 の manifest の照合が一致する', {skip: SKIP, timeout: 300000}, async (t) => {
  const fx = await fixture();
  const root = join(tempDir(t, 'pg-drill-e-'), 'ondrill');
  const run = await runPs1(E_PS1, ['-LocalTarget', '-ManifestFile', fx.manifestFile, '-WorkRoot', root], {env: localEnv(fx)});
  assert.equal(run.code, 0, run.output.slice(-3000));
  const work = eWorkDir(root);
  const result = readResult(join(work, 'pg-E-result.json'));
  assert.equal(result.drill, 'E');
  assert.equal(result.mode, 'local');
  assert.equal(result.outcome, 'ok');
  assert.equal(result.reconcile_equal, true);
  assert.equal(result.differences, 0);
  assert.equal(result.tables, fx.manifest.tables.length);
  assert.equal(result.manifest_key, fx.manifestKey);
  assert.equal(result.manifest_sha256, sha256(readFileSync(fx.manifestFile)));
  assert.equal(result.hours_since_snapshot < 1, true);
  assertTimes(result, ['started', 'reconcile_finished']);
  assert.equal(result.times_utc.pitr_started, null, '-LocalTarget では PITR を尋ねない');
  // psql の出力（件数と金額の合計だけ）を照合に使った
  const read = JSON.parse(readFileSync(join(work, 'pitr.json'), 'utf8'));
  assert.equal(read.length, fx.manifest.tables.length);
  assert.match(run.stdout, /^OK {2}照合: 一致/m);
  assert.match(run.stdout, /^判定: OK$/m);
  assert.doesNotMatch(JSON.stringify(result) + run.output, new RegExp(FAKE_PASSWORD));
});

test('E: 24時間を過ぎた manifest では、照合の前に止まり次の世代でやり直す案内を出す', {skip: SKIP, timeout: 300000}, async (t) => {
  const fx = await fixture();
  const dir = tempDir(t, 'pg-drill-e-');
  const root = join(dir, 'ondrill');
  const old = new Date(Date.now() - 25 * 3600 * 1000).toISOString().replace('T', ' ').replace('Z', '000+00');
  const oldManifest = join(dir, ...fx.manifestKey.split('/'));
  mkdirSync(resolve(oldManifest, '..'), {recursive: true});
  writeFileSync(oldManifest, JSON.stringify({...fx.manifest, snapshot_at: old}));
  const run = await runPs1(E_PS1, ['-LocalTarget', '-ManifestFile', oldManifest, '-WorkRoot', root], {env: localEnv(fx)});
  assert.equal(run.code, 1, run.output.slice(-3000));
  assert.match(run.stdout, /^NG {2}G1 の snapshot から 24 時間を過ぎている$/m);
  assert.match(run.stdout, /^次の一手: 次の世代を基準にやり直す/m);
  const work = eWorkDir(root);
  assert.equal(existsSync(join(work, 'pitr.json')), false, '照合の読み取りをしない');
  const result = readResult(join(work, 'pg-E-result.json'));
  assert.equal(result.outcome, 'ng');
  assert.equal(result.hours_since_snapshot >= 25, true);
});

// 戻す時刻（UTC の YYYY-MM-DDTHH:mm:ssZ）を、ps1 が並べて出す「YYYY-MM-DD HH:mm:ss」の UTC と日本時間にする
const plainOf = (utc, hours = 0) => new Date(Date.parse(utc) + hours * 3600 * 1000).toISOString().slice(0, 19).replace('T', ' ');
const PASTED_CREATE = 'pscale branch create openingnight_integrated integrated-drill-fictional --from main --restore-point 2026-01-01T00:00:00Z';
const PASTED_DELETE = 'pscale branch delete openingnight_integrated integrated-drill-fictional';
const PASTED_NOTICE = /この窓に打った・貼った行は流れていない。pscale の行は別の PowerShell の窓（pscale にログインした窓）で流し、この窓では Enter だけを押す/g;

test('E: G1 の後に staging を使ったかの問いは Enter だけで進み、no 以外の答え（n・No.・yes）でも止まる', {skip: SKIP, timeout: 300000}, async (t) => {
  const fx = await fixture();
  for (const answer of ['no', 'n', 'No.', 'yes']) {
    const root = join(tempDir(t, 'pg-drill-e-'), 'ondrill');
    const run = await runPs1(E_PS1, ['-ManifestFile', fx.manifestFile, '-WorkRoot', root], {input: `${answer}\r\n`});
    assert.equal(run.code, 1, `${answer}: ${run.output.slice(-3000)}`);
    assert.match(run.stdout, /^NG {2}G1 の後に staging を使ったかもしれない（Enter 以外の答え。G1 と drill が合わなくなる）$/m, answer);
    assert.match(run.stdout, /^次の一手: 次の世代を基準にやり直す/m);
    const result = readResult(join(eWorkDir(root), 'pg-E-result.json'));
    assert.equal(result.restore_point_utc, null, `${answer}: 戻す時刻を記録しない`);
    assert.doesNotMatch(run.stdout, /drill のブランチ .* を PlanetScale で消す/, 'PITR を始めていないので消す案内は出ない');
  }
});

test('E: PlanetScale に向ける問いの流れで、manifest を取り、戻す時刻と pscale の1行を出し、接続の前に止まっても drill のブランチを消した時刻を残す', {skip: SKIP, timeout: 300000}, async (t) => {
  const fx = await fixture();
  const fake = fakeNpx(t, fx.archive);
  // G1 の後に staging を使っていない → 1件入れた → PITR を始めた（pscale の行をこの窓に貼ってしまい、尋ね直されて Enter）→ 復旧の時刻が合う
  // → つながるようになった → 接続の値 → （止まったあと）ブランチを消した（ここでも pscale の行を貼ってしまい、尋ね直されて Enter）
  const flow = async (values) => {
    const root = join(tempDir(t, 'pg-drill-e-'), 'ondrill');
    const input = ['', '', PASTED_CREATE, '', '', '', ...values, PASTED_DELETE, ''].join('\r\n') + '\r\n';
    // -ManifestFile を付けないので、F と同じ取得（manifest だけ）で G1 の manifest を用意する
    const run = await runPs1(E_PS1, ['-ManifestKey', fx.manifestKey, '-WorkRoot', root], {input, env: fake.env, pathPrefix: fake.pathPrefix});
    const work = eWorkDir(root);
    return {run, work, calls: fake.take(), result: readResult(join(work, 'pg-E-result.json'))};
  };

  // Host の形が違えば3回まで尋ね直し、3回とも違えば止まる
  const wrong = await flow(['https://drill-host.fictional.invalid/', 'drill host.fictional.invalid', 'drill-host.fictional.invalid:5432']);
  assert.equal(wrong.run.code, 1, wrong.run.output.slice(-3000));
  assert.equal(wrong.run.stdout.match(/Host の形が違う（https:\/\/ や :5432 を付けず、名前だけを貼る）。もう一度貼る/g)?.length, 2);
  assert.match(wrong.run.stdout, /^NG {2}Host の形が違う（https:\/\/ や :5432 を付けず、名前だけを貼る）（3回）$/m);

  // 形の合う Host と Username のあと、管で渡した入力ではパスワードを尋ねずに止まる（-AsSecureString は管の入力を読めず止まったままになる）
  const piped = await flow(['drill-host.fictional.invalid', 'fictional-drill-user']);
  assert.equal(piped.run.code, 1, piped.run.output.slice(-3000));
  assert.match(piped.run.stdout, /^NG {2}パスワードは画面で入力する（入力を管で渡さない）$/m);

  for (const {run, work, calls, result} of [wrong, piped]) {
    assert.deepEqual(calls.map((call) => call.args.slice(2)),
      [['whoami', '--json'], ['r2', 'object', 'get', `${BUCKET}/${fx.manifestKey}`, '--remote', '--file', join(work, ...fx.manifestKey.split('/'))]]);
    for (const call of calls) {
      assert.equal(resolve(call.cwd).toLowerCase(), APP.toLowerCase());
      assert.equal(call.account, ACCOUNT_ID);
    }
    assert.equal(result.manifest_key, fx.manifestKey);
    assert.equal(result.manifest_sha256, sha256(readFileSync(fx.manifestFile)));
    assert.equal(result.mode, 'planetscale');
    assert.equal(result.outcome, 'ng');
    assert.match(result.restore_point_utc, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
    assert.equal(Date.parse(result.restore_point_utc) > Date.parse(result.snapshot_at_utc), true, '戻す時刻は G1 の snapshot より後');
    assert.equal(result.drill_branch, `integrated-drill-${result.restore_point_utc.replace(/[-:TZ]/g, '')}`);
    assert.match(run.stdout, new RegExp(`^ {5}pscale branch create openingnight_integrated ${result.drill_branch} --from main --restore-point ${result.restore_point_utc}$`, 'm'));
    assert.match(run.stdout, /「新しい」drill のブランチを作る。元の staging のブランチ（main）と本番は上書きしない/);
    // 画面の時刻の欄に合う方を貼れるように、UTC と日本時間を並べて出す。pscale は別の窓に貼る
    assert.match(run.stdout, new RegExp(`^ {3}戻す時刻（UTC）: ${result.restore_point_utc}（${plainOf(result.restore_point_utc)}）$`, 'm'));
    assert.match(run.stdout, new RegExp(`^ {3}戻す時刻（日本時間）: ${plainOf(result.restore_point_utc, 9)}$`, 'm'));
    assert.match(run.stdout, /時刻の欄が UTC か日本時間かを画面の表示で見て/);
    assert.match(run.stdout, /次の1行を、別の PowerShell の窓（pscale にログインした窓）に貼って流す。この窓には貼らない/);
    // PITR の開始と削除の問いに貼った pscale の行は答えに使わず、尋ね直す
    assert.equal(run.stdout.match(PASTED_NOTICE)?.length, 2);
    assert.match(run.stdout, new RegExp(`その表示が UTC なら ${plainOf(result.restore_point_utc)}、日本時間なら ${plainOf(result.restore_point_utc, 9)} と同じかを確かめる`));
    assert.match(run.stdout, /Create a role で「Default role」を作る/);
    assertTimes(result, ['insert_done', 'pitr_started', 'connectable', 'branch_deleted']);
    assert.equal(result.pitr_rounds, 1);
    assert.equal(Date.parse(result.times_utc.insert_done) >= Date.parse(result.restore_point_utc), true, '1件は戻す時刻の後に入れる');
    assert.equal(Number.isInteger(result.durations_ms.pitr_to_connectable), true);
    assert.equal(Number.isInteger(result.durations_ms.branch_lifetime), true);
    assert.equal(result.reconcile_equal, null);
    assert.equal(existsSync(join(work, 'pitr.json')), false, '接続の前に止まった');
    assert.match(run.stdout, new RegExp(`pscale branch delete openingnight_integrated ${result.drill_branch}`));
    assert.match(run.stdout, /^判定: NG$/m);
  }
});

// 画面の問いの答え（runPs1Console）: G1 の後に使っていない → 1件 → PITR の開始 → 復旧の時刻が合う → つながる → Host → Username → Password
const CONSOLE_HOST = 'drill-host.fictional.invalid';
const CONSOLE_USER = 'fictional-drill-user';
const CONSOLE_PASSWORD = 'fictional-typed-password';
const STALE = {PGHOST: 'stale-host.fictional.invalid', PGUSER: 'stale-fictional-user', PGPASSWORD: 'stale-fictional-password'};

// F の作業フォルダ（ondrill の直下の pg-F-<時刻>）に G1 の manifest を置く（F の最後に出る1行の -ManifestFile と同じ形）
function placeFWorkDir(root, fx, manifest = fx.manifest) {
  const fDir = join(root, 'pg-F-20261009-000000');
  const manifestFile = join(fDir, ...fx.manifestKey.split('/'));
  mkdirSync(dirname(manifestFile), {recursive: true});
  if (manifest === fx.manifest) copyFileSync(fx.manifestFile, manifestFile);
  else writeFileSync(manifestFile, JSON.stringify(manifest));
  writeFileSync(join(fDir, 'pg-F-result.json'), '{"drill":"F","outcome":"ok"}');
  return {fDir, manifestFile};
}

test('E: PlanetScale に向ける流れを画面の問いで最後まで流すと、窓に残った接続値を使わずに尋ね、照合が一致し、F と E の作業フォルダを片づける', {skip: SKIP, timeout: 300000}, async (t) => {
  const fx = await fixture();
  const root = join(tempDir(t, 'pg-drill-e-'), 'ondrill');
  const {manifestFile} = placeFWorkDir(root, fx);
  const docker = fakeDocker(t, fx.pitrJson);
  // 03 の共通準備を手で流した窓のように、前の接続値が残っている
  const run = await runPs1Console(t, E_PS1, {ManifestFile: manifestFile, WorkRoot: root}, {
    answers: ['', '', '', '', '', CONSOLE_HOST, CONSOLE_USER, CONSOLE_PASSWORD, '', 'yes'],
    env: {...docker.env, ...STALE}, pathPrefix: [docker.pathPrefix],
  });
  assert.equal(run.code, 0, run.output.slice(-3000));
  assert.deepEqual(run.prompts.filter((prompt) => prompt.secure).map((prompt) => prompt.prompt), ['Password'], 'パスワードは窓に残っていても必ず尋ねる');
  // psql の docker run には、尋ねて受けた値だけが渡る（名前だけを渡すので、docker の側で見える値）
  const [psql] = docker.runs();
  assert.deepEqual(psql.env, {PGHOST: CONSOLE_HOST, PGPORT: '5432', PGUSER: CONSOLE_USER, PGPASSWORD: CONSOLE_PASSWORD, PGDATABASE: 'postgres', PGSSLMODE: 'verify-full'});
  const pairs = psql.args.map((arg, index) => `${arg} ${psql.args[index + 1]}`);
  for (const pair of ['-e PGHOST', '-e PGPASSWORD', '-e PGSSLROOTCERT=system', '-v ON_ERROR_STOP=1']) assert.ok(pairs.includes(pair), pair);
  assert.equal(psql.args.includes('-1'), false, '-1 を付けない');
  assert.doesNotMatch(psql.args.join(' '), new RegExp(`${CONSOLE_PASSWORD}|${CONSOLE_HOST}`), '接続値を docker の引数に書かない');
  assert.doesNotMatch(run.output, new RegExp(`${CONSOLE_PASSWORD}|${STALE.PGPASSWORD}`));
  assert.match(run.stdout, /^OK {2}照合: 一致/m);
  assert.match(run.stdout, /^OK {2}G1 の後に staging へ入れた1件は drill に無い/m);
  assert.match(run.stdout, /^判定: OK$/m);
  // 片付け: F（-ManifestFile のある pg-F-<時刻>）と E の作業フォルダを消し、結果の JSON だけを ondrill の直下に残す
  const left = readdirSync(root).sort();
  assert.equal(left.length, 2, left.join(','));
  assert.equal(left[1], 'pg-F-20261009-000000-result.json');
  assert.match(left[0], /^pg-E-\d{8}-\d{6}-result\.json$/);
  const result = readResult(join(root, left[0]));
  assert.equal(result.outcome, 'ok');
  assert.equal(result.mode, 'planetscale');
  assert.equal(result.reconcile_equal, true);
  assert.equal(result.pitr_rounds, 1);
  assertTimes(result, ['insert_done', 'pitr_started', 'connectable', 'reconcile_finished', 'branch_deleted']);
  for (const name of ['pitr_to_connectable', 'connectable_to_reconciled', 'pitr_to_reconciled', 'branch_lifetime']) assert.equal(Number.isInteger(result.durations_ms[name]), true, name);
});

test('E: 画面の問いで、復旧の時刻が違えば同じ時刻で作り直し、docker が 125 で終われば同じ drill のブランチで照合をやり直す', {skip: SKIP, timeout: 300000}, async (t) => {
  const fx = await fixture();
  const root = join(tempDir(t, 'pg-drill-e-'), 'ondrill');
  const {manifestFile} = placeFWorkDir(root, fx);
  const docker = fakeDocker(t, fx.pitrJson, '125,0');
  const run = await runPs1Console(t, E_PS1, {ManifestFile: manifestFile, WorkRoot: root}, {
    // 復旧の時刻: yes（Enter か no で答え直す）→ no（作り直す）→ 作り直しを始めた → 合う。docker の 125 のあと Enter。最後は作業フォルダを残す
    answers: ['', '', '', 'yes', 'no', '', '', '', CONSOLE_HOST, CONSOLE_USER, CONSOLE_PASSWORD, '', '', ''],
    env: docker.env, pathPrefix: [docker.pathPrefix],
  });
  assert.equal(run.code, 0, run.output.slice(-3000));
  const work = eWorkDir(root);
  const result = readResult(join(work, 'pg-E-result.json'));
  const first = `integrated-drill-${result.restore_point_utc.replace(/[-:TZ]/g, '')}`;
  assert.equal(result.pitr_rounds, 2);
  assert.equal(result.drill_branch, `${first}-2`, '作り直したブランチは新しい名前');
  assert.match(run.stdout, /^ {3}Enter だけ（同じ）か no（違う・分からない）で答える。pscale の行はこの窓では流れない$/m);
  assert.match(run.stdout, new RegExp(`^ {3}その drill のブランチ（${first}）は使わない。PlanetScale で消してから、同じ戻す時刻で、次の新しい名前のブランチを作り直す$`, 'm'));
  assert.match(run.stdout, new RegExp(`^ {5}pscale branch create openingnight_integrated ${first}-2 --from main --restore-point ${result.restore_point_utc}$`, 'm'), '作り直しも同じ戻す時刻');
  assert.ok(run.prompts.some((prompt) => prompt.prompt === '前の drill のブランチを消し、作り直しを始めたら Enter'));
  // docker の 125 は Docker の失敗として案内し、Enter のあとに同じ照合をもう一度流す
  assert.match(run.stdout, /^ {3}手元の Docker で psql を始められなかった（docker の終了コード 125。像の取得か Docker の不調）$/m);
  assert.doesNotMatch(run.stdout, /psql の終了コード 125|ロールに読み取りの権限/);
  assert.equal(docker.runs().length, 2);
  assert.ok(run.prompts.some((prompt) => prompt.prompt.startsWith('Docker Desktop を起動し直し、起動が終わったら Enter')));
  assert.match(run.stdout, /^PITR は 2 回目に作ったブランチで測った/m);
  assert.match(run.stdout, /^作業フォルダを残した$/m);
  assert.match(run.stdout, /^判定: OK$/m);
  assert.equal(result.reconcile_equal, true);
});

test('E: 画面の問いで待つあいだに G1 から24時間を過ぎたら、PITR を始めたときに止め、drill のブランチの消し方を出して消した時刻を尋ねる', {skip: SKIP, timeout: 300000}, async (t) => {
  const fx = await fixture();
  const root = join(tempDir(t, 'pg-drill-e-'), 'ondrill');
  // 起動したときと戻す時刻のときは24時間以内（15秒の余裕）で、PITR の開始の問いで20秒待つと過ぎる
  const snapshot = new Date(Date.now() - 24 * 3600 * 1000 + 15000).toISOString().replace('T', ' ').replace('Z', '000+00');
  const {manifestFile} = placeFWorkDir(root, fx, {...fx.manifest, snapshot_at: snapshot});
  const docker = fakeDocker(t, fx.pitrJson);
  const run = await runPs1Console(t, E_PS1, {ManifestFile: manifestFile, WorkRoot: root}, {
    answers: ['', '', '', ''], env: docker.env, pathPrefix: [docker.pathPrefix], sleepAt: 'PITR を始めたら', sleepSeconds: 20,
  });
  assert.equal(run.code, 1, run.output.slice(-3000));
  assert.match(run.stdout, /^NG {2}G1 の snapshot から 24 時間を過ぎている（PITR を始めたとき）$/m);
  assert.match(run.stdout, /^次の一手: このあと drill のブランチを消す。次の世代を基準にやり直す/m);
  const result = readResult(join(eWorkDir(root), 'pg-E-result.json'));
  assert.match(run.stdout, new RegExp(`^drill のブランチ ${result.drill_branch} を PlanetScale で消す`, 'm'));
  assert.match(run.stdout, new RegExp(`pscale branch delete openingnight_integrated ${result.drill_branch}$`, 'm'));
  assertTimes(result, ['pitr_started', 'branch_deleted']);
  assert.equal(result.times_utc.connectable, null);
  assert.equal(docker.runs().length, 0, '照合に進まない');
});

test('E: PITR を始めたあとに途中で止まっても（finally だけが流れる）、drill のブランチの名前と消し方を出す', {skip: SKIP, timeout: 300000}, async (t) => {
  const fx = await fixture();
  const root = join(tempDir(t, 'pg-drill-e-'), 'ondrill');
  const {manifestFile} = placeFWorkDir(root, fx);
  const docker = fakeDocker(t, fx.pitrJson);
  // 接続可能の問いで、答えずに exit（Ctrl+C や窓を閉じたときの代わり。catch とその後は流れない）
  const run = await runPs1Console(t, E_PS1, {ManifestFile: manifestFile, WorkRoot: root}, {
    answers: ['', '', '', ''], env: docker.env, pathPrefix: [docker.pathPrefix], exitAt: 'drill のブランチにつながるようになったら',
  });
  assert.equal(run.code, 99, run.output.slice(-3000));
  const result = readResult(join(eWorkDir(root), 'pg-E-result.json'));
  assert.match(result.drill_branch, /^integrated-drill-\d{14}$/);
  assert.match(run.stdout, new RegExp(`^drill のブランチ ${result.drill_branch} を PlanetScale で消す（名前に drill があることを確かめる。元の main は消さない）$`, 'm'));
  assert.match(run.stdout, new RegExp(`^ {3}pscale で消すとき（別の PowerShell の窓で）: pscale branch delete openingnight_integrated ${result.drill_branch}$`, 'm'));
  assert.doesNotMatch(run.stdout, /判定:/, '止まったあとの問いと判定は出ない');
  assert.equal(run.prompts.some((prompt) => prompt.prompt === 'drill のブランチを消したら Enter'), false);
});

// 照合の不一致の試験は手元の DB に1件足すので、ほかの E の試験の後に置く
test('E: -LocalTarget で、1件足した手元の DB では照合が不一致で止まる', {skip: SKIP, timeout: 300000}, async (t) => {
  const fx = await fixture();
  const root = join(tempDir(t, 'pg-drill-e-'), 'ondrill');
  await fx.target.query("INSERT INTO organizations (code, name) VALUES ('fictional-drill-extra', '架空の追加の組織')");
  const run = await runPs1(E_PS1, ['-LocalTarget', '-ManifestFile', fx.manifestFile, '-WorkRoot', root], {env: localEnv(fx)});
  assert.equal(run.code, 1, run.output.slice(-3000));
  assert.match(run.stdout, /^NG {2}照合が不一致（違い 1 件: organizations（row_count））$/m);
  assert.match(run.stdout, /^判定: NG$/m);
  const result = readResult(join(eWorkDir(root), 'pg-E-result.json'));
  assert.equal(result.outcome, 'ng');
  assert.equal(result.reconcile_equal, false);
  assert.equal(result.differences, 1);
});
