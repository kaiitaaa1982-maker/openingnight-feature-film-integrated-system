#!/usr/bin/env node
// npm run metrics — 統合システムの指標を JSON で出し、goal の閾値と比べて合否を返す（goal_check）。
// goal の書き方・指標の一覧・指標の足し方は goals/README.md（loop-ux #2 とフェーズ1 #19 で共用。K-15）。
// 出すのは、同じコミットで2回流して同じ値になるものだけ（K-11）。時刻・所要時間・乱数・手元のパスを入れない。
//
//   npm run -s metrics                                         静的な指標（試験の本数・FR の状態・借り）
//   npm run -s metrics -- --tests test/a.test.mjs …            その試験を流した結果を足す（changed＝差分から選ぶ・all＝全部）
//   npm run -s metrics -- --tests changed --engine sqlite,pg   PostgreSQL（ON_TEST_PG_URL が無ければ PGlite）でも流す
//   npm run -s metrics -- --baseline <コミット>                基準のコミットの静的な指標と、FR の後戻りを足す
//   npm run -s metrics -- --goal goals/<名前>.md               goal の tests・engine・baseline を使い、goal_check の合否を足す
//   --out <ファイル>                                           同じ JSON をファイルにも書く
// 標準出力は JSON だけ。試験の経過と要約は標準エラーへ出す。
// 終了コード: 0＝出せた（goal があれば PASS）、1＝goal_check が FAIL、2＝引数・goal の書き方・試験の起動の誤り
import {readFileSync, readdirSync, existsSync, writeFileSync, mkdirSync, mkdtempSync, rmSync} from 'node:fs';
import {join, dirname, resolve, relative} from 'node:path';
import {tmpdir} from 'node:os';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {spawnSync, execFileSync} from 'node:child_process';
import {scanJs} from '../test/js-scan.mjs';
import {STATES, frontmatter, parseRequirements} from '../test/requirements-parse.mjs';
import {pgTestFiles} from '../test/pg-matrix.mjs';
import {createContext, selectTests, executionPlan} from './select-tests.mjs';

export const APP_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const REPORTER = pathToFileURL(join(APP_DIR, 'scripts', 'metrics-reporter.mjs')).href;
const ENGINES = ['sqlite', 'pg'];
const slash = path => path.replaceAll('\\', '/');
const json = text => JSON.parse(text.replace(/^﻿/, ''));
const sum = values => values.reduce((a, b) => a + b, 0);
const sortedObject = entries => Object.fromEntries([...entries].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));

export class UsageError extends Error {}

// ---------- 読む元（パスはアプリ相対の posix。files は並べた一覧、read は中身か null） ----------

export function workingTree(appDir = APP_DIR) {
  const walk = dir => (existsSync(join(appDir, dir)) ? readdirSync(join(appDir, dir), {withFileTypes: true}) : [])
    .flatMap(entry => (entry.isDirectory() ? walk(`${dir}/${entry.name}`) : [`${dir}/${entry.name}`]));
  return {
    files: (dir, pattern) => walk(dir).filter(path => pattern.test(path)).sort(),
    read: path => (existsSync(join(appDir, path)) ? readFileSync(join(appDir, path), 'utf8') : null),
  };
}

function git(args, {cwd = APP_DIR, input} = {}) {
  return execFileSync('git', args, {cwd, input, stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'], maxBuffer: 512 * 1024 * 1024});
}

// コミットの中身を読む元（基準のコミットの指標に使う）。files で挙げたファイルは git cat-file --batch で1回にまとめて読む
export function gitTree(ref, {appDir = APP_DIR} = {}) {
  let commit;
  try { commit = git(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], {cwd: appDir}).toString('utf8').trim(); }
  catch { throw new UsageError(`基準のコミットが無い: ${ref}`); }
  const prefix = git(['rev-parse', '--show-prefix'], {cwd: appDir}).toString('utf8').trim();
  const cache = new Map();
  const load = paths => {
    const want = [...new Set(paths)].filter(path => !cache.has(path));
    if (!want.length) return;
    const out = git(['cat-file', '--batch'], {cwd: appDir, input: want.map(path => `${commit}:${prefix}${path}`).join('\n') + '\n'});
    let at = 0;
    for (const path of want) {
      const eol = out.indexOf(0x0a, at);
      const header = /^[0-9a-f]+ (\w+) (\d+)$/.exec(out.subarray(at, eol).toString('utf8'));
      at = eol + 1;
      if (!header) { cache.set(path, null); continue; }
      const size = Number(header[2]);
      cache.set(path, header[1] === 'blob' ? out.subarray(at, at + size).toString('utf8') : null);
      at += size + 1;
    }
  };
  return {
    commit,
    files(dir, pattern) {
      const list = git(['ls-tree', '-r', '--name-only', '-z', commit, '--', dir], {cwd: appDir}).toString('utf8')
        .split('\0').filter(Boolean).map(slash).filter(path => pattern.test(path)).sort();
      load(list);
      return list;
    },
    read(path) { load([path]); return cache.get(path); },
  };
}

// ---------- 静的な指標（読む元だけから決まる。基準のコミットでも同じ関数で数える） ----------

const TEST_FILE = /^test\/[^/]+\.test\.mjs$/;
// 書いた試験の数＝そのまま呼んだ test( と it( と、その .skip・.todo。コメントと文字列・正規表現の中は scanJs が消す。
// 何かの後ろの .test( は数えない（正規表現の re.test(…) と、流して数える試験の中の試験 t.test(…)）
const TEST_CALL = /(?<![\w$.])(?<!\.\s+)(?:test|it)\s*(?:\.\s*(\w+)\s*)?\(/g;

export function countDeclaredTests(text) {
  let declared = 0;
  let skipOrTodo = 0;
  for (const m of scanJs(text).masked.matchAll(TEST_CALL)) {
    if (m[1] === 'skip' || m[1] === 'todo') skipOrTodo++;
    else if (!m[1] || m[1] === 'only') declared++;
  }
  return {declared, skipOrTodo};
}

const REQUIREMENT_FILE = /^docs\/requirements\/.+\.md$/;
const requirementFiles = source => source.files('docs/requirements', REQUIREMENT_FILE).filter(path => !path.endsWith('/README.md'));

// 機能要件の表の行（番号・状態・ファイル）。読み方は requirements-trace.test.mjs と同じ（test/requirements-parse.mjs）
export function frRows(source) {
  const broken = [];
  const rows = requirementFiles(source).flatMap(file => {
    const parsed = parseRequirements(source.read(file) ?? '', file);
    broken.push(...parsed.broken);
    return parsed.rows.map(row => ({id: row.id, state: row.state, file}));
  });
  return {rows, broken};
}

function countStates(rows) {
  const out = Object.fromEntries([...STATES].map(state => [state, 0]));
  for (const row of rows) out[row.state] = (out[row.state] ?? 0) + 1;
  return out;
}

function groupStates(rows, keyOf) {
  const groups = new Map();
  for (const row of rows) {
    const key = keyOf(row);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  }
  return sortedObject([...groups].map(([key, list]) => [key, countStates(list)]));
}

// 基準のコミットからの FR の動き。後戻り＝基準でテストか画面だった番号が未検証になった。消えた番号は行を消した（requirements.md は消さず廃止にする）
export function frSince(baseRows, nowRows) {
  const base = new Map(baseRows.map(row => [row.id, row.state]));
  const now = new Map(nowRows.map(row => [row.id, row.state]));
  const regressedIds = [...now].filter(([id, state]) => state === '未検証' && ['テスト', '画面'].includes(base.get(id))).map(([id]) => id).sort();
  const removedIds = [...base.keys()].filter(id => !now.has(id)).sort();
  const added = nowRows.filter(row => !base.has(row.id));
  return {regressed: regressedIds.length, regressedIds, removed: removedIds.length, removedIds, added: added.length, addedByState: countStates(added)};
}

// 借りの一覧（test/*-debt.json）の数え方: 数はその値、配列は要素の数、オブジェクトは中の和。文字列（note）は数えない
export function countDebt(value) {
  if (typeof value === 'number') return value;
  if (Array.isArray(value)) return value.length;
  if (value && typeof value === 'object') return sum(Object.values(value).map(countDebt));
  return 0;
}

// ---------- 試験を流す（作業中の状態だけ。頼まれたときだけ） ----------

// changed の選び方（scripts/select-tests.mjs が origin/main との差分から選ぶ）。試験では架空の選び方に替える
function selectChangedTests() {
  const context = createContext();
  return {context, result: selectTests({context})};
}

// 流す計画: エンジンごとに、node --test を1回ずつ流す群（cwd・名前に付ける prefix・files）の並び。
// core の T0 の本は core で流し、名前に ../../ を付けてアプリ相対にそろえる
export function testPlan({tests, engines}, {appDir = APP_DIR, selectChanged = selectChangedTests} = {}) {
  const matrix = json(readFileSync(join(appDir, 'test', 'pg-matrix.json'), 'utf8'));
  const sqliteOnly = new Set(matrix.sqliteOnly.map(entry => `test/${entry.file}`));
  const pgReal = Boolean(process.env.ON_TEST_PG_URL);
  const plan = {};
  if (tests === 'all') {
    const all = workingTree(appDir).files('test', TEST_FILE);
    plan.sqlite = [{cwd: appDir, prefix: '', files: all}];
    if (engines.includes('pg')) {
      if (!pgReal) throw new UsageError('全部の試験を PGlite では流さない（docs/rules/testing.md）。PostgreSQL は ON_TEST_PG_URL を渡すか、ファイルを挙げる');
      plan.pg = [{cwd: appDir, prefix: '', files: pgTestFiles(matrix, all.map(path => path.slice('test/'.length))).map(name => `test/${name}`)}];
    }
  } else if (tests === 'changed') {
    const {context, result} = selectChanged();
    const sqlite = executionPlan(result, context, 'sqlite');
    plan.sqlite = [{cwd: appDir, prefix: '', files: sqlite.app}, {cwd: resolve(appDir, '../..'), prefix: '../../', files: sqlite.core}];
    if (engines.includes('pg')) {
      if (result.full && !pgReal) throw new UsageError('差分から全部が選ばれたので PGlite では流さない（docs/rules/testing.md）。ON_TEST_PG_URL を渡すか、ファイルを挙げる');
      plan.pg = [{cwd: appDir, prefix: '', files: executionPlan(result, context, 'pg').app}];
    }
  } else {
    const files = [...new Set(tests.map(file => slash(relative(appDir, resolve(appDir, file)))))].sort();
    const wrong = files.filter(file => !TEST_FILE.test(file) || !existsSync(join(appDir, file)));
    if (wrong.length) throw new UsageError(`試験のファイルが無い（test/<名前>.test.mjs で挙げる）: ${wrong.join('、')}`);
    plan.sqlite = [{cwd: appDir, prefix: '', files}];
    if (engines.includes('pg')) plan.pg = [{cwd: appDir, prefix: '', files: files.filter(file => !sqliteOnly.has(file))}];
  }
  if (!engines.includes('sqlite')) delete plan.sqlite;
  return plan;
}

// node --test を1回流し、metrics-reporter.mjs が書いた件数と失敗の名前を読む。progress は経過の点を標準エラーに出すか
export function runNodeTests({cwd, files, env = {}, progress = true}) {
  const zero = {tests: 0, passed: 0, failed: 0, cancelled: 0, skipped: 0, todo: 0};
  if (!files.length) return {counts: zero, failures: [], exitCode: 0};
  const dir = mkdtempSync(join(tmpdir(), 'on-metrics-'));
  const out = join(dir, 'result.json');
  try {
    const childEnv = {...process.env, ...env};
    delete childEnv.NODE_TEST_CONTEXT; // 試験の中から呼んだときも、子の node --test を親の試験の一部にしない
    const child = spawnSync(process.execPath, ['--test', '--test-concurrency=1',
      `--test-reporter=${REPORTER}`, `--test-reporter-destination=${out}`,
      ...(progress ? ['--test-reporter=dot', '--test-reporter-destination=stderr'] : []), ...files], {cwd, env: childEnv, stdio: ['ignore', 2, 2]});
    if (child.error) throw child.error;
    if (!existsSync(out)) throw new Error('試験の結果が書かれていない（node --test が起動しなかった）');
    const result = json(readFileSync(out, 'utf8'));
    if (!result.counts) throw new Error('試験の件数が無い（node --test が途中で止まった）');
    return {...result, exitCode: child.signal ? 1 : child.status ?? 1};
  } finally {
    rmSync(dir, {recursive: true, force: true});
  }
}

// 計画の群を流し、エンジンごとに件数は群の和、終了コードは群の最大、落ちた試験の名前は prefix を付けて並べ替える
export function runPlan(plan, {progress = true} = {}) {
  const out = {};
  for (const engine of ENGINES) {
    if (!plan[engine]) continue;
    const env = {ON_TEST_DB: engine};
    const runs = plan[engine].map(group => ({group, result: runNodeTests({cwd: group.cwd, files: group.files, env, progress})}));
    const files = runs.flatMap(({group}) => group.files.map(file => group.prefix + file));
    const counts = Object.fromEntries(Object.keys(runs[0].result.counts).map(key => [key, sum(runs.map(r => r.result.counts[key]))]));
    out[engine] = {
      target: engine === 'sqlite' ? 'sqlite' : process.env.ON_TEST_PG_URL ? 'postgres' : 'pglite',
      fileCount: files.length,
      ...counts,
      exitCode: Math.max(...runs.map(r => r.result.exitCode)),
      failures: runs.flatMap(({group, result}) => result.failures.map(name => group.prefix + name)).sort(),
      files,
    };
  }
  return out;
}

// 計画を作ってから（誤りなら前処理も試験も流さない）、npm test と同じ前処理を流し、計画を流す
export function runTests(options, {appDir = APP_DIR, selectChanged, progress = true} = {}) {
  const plan = testPlan(options, {appDir, selectChanged});
  const prepare = spawnSync(process.execPath, ['scripts/prepare-test-assets.mjs'], {cwd: appDir, stdio: ['ignore', 2, 2]});
  return {selection: Array.isArray(options.tests) ? 'files' : options.tests, prepared: prepare.status === 0, ...runPlan(plan, {progress})};
}

// ---------- 指標の集め方（#19 で足すときは、この配列に1つ足す。goals/README.md「指標を足す」） ----------
// kind: 'static' … collect({source}) は読む元だけから値を決める。基準のコミットでも同じ関数で数える
// kind: 'run'    … enabled(options) のときだけ、作業中の状態で何かを流して値を得る。頼まれないときは null
export const COLLECTORS = [
  {
    key: 'tests', kind: 'static', title: '試験の本数',
    collect({source}) {
      const files = source.files('test', TEST_FILE);
      const counts = files.map(file => countDeclaredTests(source.read(file) ?? ''));
      const matrixText = source.read('test/pg-matrix.json');
      const matrix = matrixText ? json(matrixText) : {};
      return {
        files: files.length,
        declared: sum(counts.map(c => c.declared)),
        declaredSkipOrTodo: sum(counts.map(c => c.skipOrTodo)),
        pgPending: matrix.pending?.length ?? null,
        sqliteOnly: matrix.sqliteOnly?.length ?? null,
      };
    },
  },
  {
    key: 'fr', kind: 'static', title: 'FR の状態の件数',
    collect({source}) {
      const {rows, broken} = frRows(source);
      return {
        files: requirementFiles(source).length,
        total: rows.length,
        byState: countStates(rows),
        byDomain: groupStates(rows, row => row.file.split('/')[2]),
        byFile: groupStates(rows, row => row.file.slice('docs/requirements/'.length, -'.md'.length)),
        broken: broken.length,
      };
    },
  },
  {
    key: 'debt', kind: 'static', title: '借りの数',
    collect({source}) {
      const byFile = sortedObject(source.files('test', /^test\/[^/]+-debt\.json$/).map(file => {
        const data = json(source.read(file));
        const kinds = sortedObject(Object.entries(data).filter(([, value]) => typeof value !== 'string').map(([kind, value]) => [kind, countDebt(value)]));
        return [file.slice('test/'.length, -'-debt.json'.length), {total: sum(Object.values(kinds)), kinds}];
      }));
      return {total: sum(Object.values(byFile).map(entry => entry.total)), byFile};
    },
  },
  {
    key: 'testRun', kind: 'run', title: '試験の結果',
    enabled: options => Boolean(options.tests),
    collect: ({options, appDir}) => runTests(options, {appDir}),
  },
];

export function staticMetrics(source) {
  return Object.fromEntries(COLLECTORS.filter(c => c.kind === 'static').map(c => [c.key, c.collect({source})]));
}

function headCommit(appDir) {
  try { return git(['rev-parse', 'HEAD'], {cwd: appDir}).toString('utf8').trim(); } catch { return null; }
}
function isDirty(appDir) {
  try { return git(['status', '--porcelain', '-z', '--', '.'], {cwd: appDir}).length > 0; } catch { return null; }
}

export async function measure({tests = null, engines = ['sqlite'], baseline = null} = {}, {appDir = APP_DIR} = {}) {
  const source = workingTree(appDir);
  const base = baseline ? gitTree(baseline, {appDir}) : null; // 基準のコミットが無ければ、試験を流す前に止める
  const options = {tests, engines};
  const result = {schema: 1, commit: headCommit(appDir), dirty: isDirty(appDir), metrics: {}, baseline: null, goalCheck: null};
  for (const collector of COLLECTORS) {
    if (collector.kind === 'static') result.metrics[collector.key] = collector.collect({source});
    else result.metrics[collector.key] = collector.enabled(options) ? await collector.collect({source, options, appDir}) : null;
  }
  if (base) {
    result.baseline = {ref: baseline, commit: base.commit, metrics: staticMetrics(base)};
    result.metrics.fr.sinceBaseline = frSince(frRows(base).rows, frRows(source).rows);
  }
  return result;
}

// ---------- goal_check（goal の md の「## goal_check」の表と比べる） ----------

const OPS = {'=': (a, b) => a === b, '<=': (a, b) => a <= b, '>=': (a, b) => a >= b, '<': (a, b) => a < b, '>': (a, b) => a > b};
const KINDS = ['守る', '伸ばす'];
const METRIC_PATH = /^[^\s.`|]+(?:\.[^\s.`|]+)*$/;

function testsSpec(value) {
  if (value === undefined || value === '') return null;
  const items = value.split(/[\s,]+/).filter(Boolean);
  return items.length === 1 && ['changed', 'all'].includes(items[0]) ? items[0] : items;
}

export function parseGoal(text, file = 'goal') {
  const fm = frontmatter(text) ?? {};
  const problems = [];
  const checks = [];
  const start = text.search(/^##\s*goal_check\s*$/m);
  if (start < 0) problems.push(`${file}: 「## goal_check」の節が無い`);
  else {
    const rest = text.slice(start).replace(/^##[^\n]*\n/, '');
    const end = rest.search(/^##\s/m);
    let fenced = false;
    for (const raw of (end < 0 ? rest : rest.slice(0, end)).split(/\r?\n/)) {
      const line = raw.trim();
      if (line.startsWith('```')) { fenced = !fenced; continue; }
      if (fenced || !line.startsWith('|') || /^\|[\s:|-]+\|$/.test(line)) continue;
      const cells = line.replace(/^\|/, '').replace(/\|$/, '').split('|').map(cell => cell.trim());
      const metric = (cells[0] ?? '').replace(/`/g, '');
      if (metric === '指標') continue;
      if (cells.length < 4 || cells.length > 5) { problems.push(`${file}: 4列か5列（指標・比べ方・値・種類・意味）でない行: ${line.slice(0, 60)}`); continue; }
      const [, op, valueText, kind] = cells;
      const value = valueText.replace(/`/g, '');
      const number = Number(value);
      if (!METRIC_PATH.test(metric)) problems.push(`${file}: 指標の書き方が違う（metrics の JSON の . 区切りの道）: ${metric}`);
      if (!OPS[op]) problems.push(`${file}: 比べ方は ${Object.keys(OPS).join(' ')} のどれか: ${op}`);
      if (value !== 'baseline' && (value === '' || !Number.isFinite(number))) problems.push(`${file}: 値は数か baseline: ${value}`);
      if (!KINDS.includes(kind)) problems.push(`${file}: 種類は 守る か 伸ばす: ${kind}`);
      checks.push({metric, op, value: value === 'baseline' ? 'baseline' : number, kind, ...(cells[4] ? {note: cells[4]} : {})});
    }
    if (!checks.length && !problems.length) problems.push(`${file}: goal_check の行が無い`);
  }
  const engines = fm.engine ? fm.engine.split(/[\s,]+/).filter(Boolean) : null;
  if (engines?.some(engine => !ENGINES.includes(engine))) problems.push(`${file}: engine は ${ENGINES.join('・')}: ${fm.engine}`);
  return {file, title: fm.title ?? null, baseline: fm.baseline || null, tests: testsSpec(fm.tests), engines, checks, problems};
}

const lookup = (object, path) => path.split('.').reduce((node, key) => (node !== null && typeof node === 'object' && Object.hasOwn(node, key) ? node[key] : undefined), object);
const isNumber = value => typeof value === 'number' && Number.isFinite(value);

export function goalCheck(goal, result) {
  const checks = goal.checks.map(check => {
    const actual = lookup(result.metrics, check.metric);
    const expected = check.value === 'baseline' ? (result.baseline ? lookup(result.baseline.metrics, check.metric) : undefined) : check.value;
    const reason = !isNumber(actual) ? '指標が無いか数でない' : !isNumber(expected) ? '基準の値が無い' : null;
    return {metric: check.metric, op: check.op, value: check.value, expected: isNumber(expected) ? expected : null,
      actual: isNumber(actual) ? actual : null, kind: check.kind, pass: !reason && OPS[check.op](actual, expected), ...(reason ? {reason} : {})};
  });
  const tally = kind => ({passed: checks.filter(c => c.kind === kind && c.pass).length, total: checks.filter(c => c.kind === kind).length});
  return {goal: goal.file, verdict: checks.length && checks.every(c => c.pass) ? 'PASS' : 'FAIL', guards: tally('守る'), targets: tally('伸ばす'), checks};
}

// ---------- コマンド ----------

function parseArgs(argv) {
  const opts = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const value = () => {
      const next = argv[++i];
      if (next === undefined || next.startsWith('--')) throw new UsageError(`値が無い: ${arg}`);
      return next;
    };
    if (arg === '--help' || arg === '-h') opts.help = true;
    else if (arg === '--goal') opts.goal = value();
    else if (arg === '--baseline') opts.baseline = value();
    else if (arg === '--out') opts.out = value();
    else if (arg === '--engine') opts.engines = value().split(',').filter(Boolean);
    else if (arg === '--tests') {
      const items = [];
      while (argv[i + 1] !== undefined && !argv[i + 1].startsWith('--')) items.push(argv[++i]);
      if (!items.length) throw new UsageError('値が無い: --tests');
      opts.tests = testsSpec(items.join(' '));
    } else throw new UsageError(`知らない引数: ${arg}`);
  }
  if (opts.engines && (!opts.engines.length || opts.engines.some(engine => !ENGINES.includes(engine)))) throw new UsageError(`--engine は ${ENGINES.join(',')} から選ぶ`);
  return opts;
}

// 標準エラーに出す要約（人が読む。JSON は標準出力）
export function summary(result) {
  const m = result.metrics;
  const lines = [`metrics: ${result.commit?.slice(0, 7) ?? 'git なし'}${result.dirty ? '（コミットしていない変更あり）' : ''}`,
    `  試験の本数: ファイル ${m.tests.files}・test ${m.tests.declared}（skip・todo ${m.tests.declaredSkipOrTodo}）`,
    `  FR: ${Object.entries(m.fr.byState).map(([state, n]) => `${state} ${n}`).join('・')}（計 ${m.fr.total}）`,
    `  借り: ${m.debt.total}（${Object.entries(m.debt.byFile).map(([name, entry]) => `${name} ${entry.total}`).join('・')}）`];
  if (m.testRun && !m.testRun.prepared) lines.push('  前処理（scripts/prepare-test-assets.mjs）が通っていない（testRun.prepared が false）: 見本の CSV・XLSX を読む試験は、前に作った見本か見本なしで流れた');
  for (const engine of ENGINES) {
    const run = m.testRun?.[engine];
    if (run) lines.push(`  試験の結果 ${run.target}: ${run.fileCount} ファイル・tests ${run.tests}・failed ${run.failed}・cancelled ${run.cancelled}・skipped ${run.skipped}`);
  }
  if (m.fr.sinceBaseline) lines.push(`  基準 ${result.baseline.commit.slice(0, 7)} から: FR の後戻り ${m.fr.sinceBaseline.regressed}・消えた番号 ${m.fr.sinceBaseline.removed}・足した番号 ${m.fr.sinceBaseline.added}`);
  const gc = result.goalCheck;
  if (gc) {
    lines.push(`goal_check: ${gc.verdict}（守る ${gc.guards.passed}/${gc.guards.total}・伸ばす ${gc.targets.passed}/${gc.targets.total}）`);
    for (const c of gc.checks) {
      const expected = c.value === 'baseline' ? `baseline(${c.expected ?? '無し'})` : c.value;
      lines.push(`  ${c.pass ? 'OK' : 'NG'} ${c.kind} ${c.metric} ${c.op} ${expected}: ${c.actual ?? '無し'}${c.reason ? `（${c.reason}）` : ''}`);
    }
  }
  return lines.join('\n') + '\n';
}

function help() {
  const lines = readFileSync(fileURLToPath(import.meta.url), 'utf8').split(/\r?\n/).slice(1);
  return lines.slice(0, lines.findIndex(line => !line.startsWith('//'))).map(line => line.replace(/^\/\/ ?/, '')).join('\n');
}

// measure に渡す options。コマンドの引数 → goal の frontmatter → 既定（試験を流さない・sqlite・基準なし）の順に決める
export function resolveOptions(opts = {}, goal = null) {
  const options = {tests: opts.tests ?? goal?.tests ?? null, engines: opts.engines ?? goal?.engines ?? ['sqlite'], baseline: opts.baseline ?? goal?.baseline ?? null};
  if (goal?.checks.some(check => check.value === 'baseline') && !options.baseline) throw new UsageError(`${goal.file}: 値に baseline を使うなら、frontmatter の baseline か --baseline で基準のコミットを渡す`);
  return options;
}

export async function main(argv = process.argv.slice(2)) {
  try {
    const opts = parseArgs(argv);
    if (opts.help) { process.stderr.write(help() + '\n'); return 0; }
    let goal = null;
    if (opts.goal) {
      const path = [resolve(process.cwd(), opts.goal), resolve(APP_DIR, opts.goal)].find(existsSync);
      if (!path) throw new UsageError(`goal が無い: ${opts.goal}`);
      goal = parseGoal(readFileSync(path, 'utf8'), slash(relative(APP_DIR, path)));
      if (goal.problems.length) throw new UsageError(goal.problems.join('\n'));
    }
    const result = await measure(resolveOptions(opts, goal));
    if (goal) result.goalCheck = goalCheck(goal, result);
    const text = JSON.stringify(result, null, 2) + '\n';
    process.stdout.write(text);
    if (opts.out) {
      const out = resolve(process.cwd(), opts.out);
      mkdirSync(dirname(out), {recursive: true});
      writeFileSync(out, text);
    }
    process.stderr.write(summary(result));
    return result.goalCheck?.verdict === 'FAIL' ? 1 : 0;
  } catch (error) {
    process.stderr.write(`metrics: ${error instanceof UsageError ? '' : '止まった: '}${error.message}\n`);
    return 2;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = await main();
