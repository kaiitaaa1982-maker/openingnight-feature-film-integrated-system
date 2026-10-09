#!/usr/bin/env node
// 段A selector。JSON のパスは core 相対、--list はアプリ相対（core の T0 は ../../）。
// URL→route の対応は PR3、履歴の台帳と CI 接続は PR4。Node 標準とローカルの字句検査だけを使う。
import {readFileSync, readdirSync, existsSync} from 'node:fs';
import {dirname, resolve, relative, join, posix} from 'node:path';
import {fileURLToPath} from 'node:url';
import {execFileSync, spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {scanJs} from '../test/js-scan.mjs';
import {mentionsMoney} from '../test/money-words.mjs';

export const APP = 'apps/integrated-prototype/';
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const HUB = APP + 'src/app.mjs';
const json = file => JSON.parse(readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
const slash = path => path.replaceAll('\\', '/');
const unique = values => [...new Set(values)].sort();
const local = path => path.startsWith(APP) ? path.slice(APP.length) : path;
const heavy = path => /\/test\/(?:seed-|demo-|measure-)/.test(path) && !/\/seed-record-(?:replay|to-sql)\.test\.mjs$/.test(path);
export const NON_IMPORT_INPUTS = [
  'migrations/9999.sql', 'src/schema.sql', 'src/example/schema.sql', 'pg/schema.sql', 'pg/local-seed.sql',
  'docs/rules/testing.md', 'docs/requirements/core/example.md', 'AGENTS.md',
  'test/money-debt.json', 'test/pg-matrix.json', 'test/always-run.json', 'test/select-map.json', 'migration-manifest.json',
].map(f => APP + f).concat(['AGENTS.md', '.claude/rules/integrated-testing.md']);
export function mapCoverageViolations(map) {
  return NON_IMPORT_INPUTS.filter(f => !map?.inputs?.some(row => typeof row.pattern === 'string' && matches(row.pattern, f)));
}

function walk(root, folder) {
  return readdirSync(join(root, folder), {withFileTypes: true}).flatMap(entry => {
    const path = folder + '/' + entry.name;
    return entry.isDirectory() ? walk(root, path) : [path];
  }).sort();
}

// コメント・文字列内の import を読まない。テンプレート内の式も再帰して読む。
export function imports(source, from) {
  const {masked, strings} = scanJs(source);
  const found = [];
  for (const str of strings) {
    for (const expr of str.expressions ?? []) found.push(...imports(expr.value, from));
    const before = masked.slice(0, str.start);
    if (!/(?:\bfrom\s*|\bimport\s*(?:\(\s*)?)$/.test(before)) continue;
    if (/^(?:data:|node:)/.test(str.value)) continue;
    if (str.expressions?.length) { found.push('@unresolved'); continue; }
    if (!str.value.startsWith('.')) continue;
    const path = posix.normalize(posix.join(posix.dirname(from), str.value));
    if (path.startsWith('../') || path.includes('?') || path.includes('#')) throw new Error(`import の範囲外: ${from}`);
    found.push(path);
  }
  // import(variable) は追跡できない。無関係な文字列内の例は masked では消えている。
  for (const m of masked.matchAll(/\bimport\s*\(\s*[^\s'"`]/g)) {
    const known = source.slice(m.index).match(/^import\(pathToFileURL\(resolve\(appRoot,\s*['"]([^'"]+)['"]\)\)\.href\)/);
    if (known) found.push(APP + known[1]);
    else found.push('@unresolved');
  }
  return unique(found);
}

export function createContext({root = ROOT} = {}) {
  const tests = walk(root, APP.slice(0, -1) + '/test').filter(f => f.endsWith('.test.mjs'));
  const context = {root, tests, sources: {}, graph: new Map(), reverse: new Map(), unresolved: []};
  // エラーでも試験一覧は残し、選択時に R7 で全部に戻す。
  try {
    context.always = json(join(root, APP, 'test/always-run.json'));
    if (!Array.isArray(context.always.tests) || context.always.tests.some(e => typeof e?.file !== 'string'
      || !e.file.endsWith('.test.mjs') || e.file.startsWith('/') || /[:\\]/.test(e.file)
      || e.file.split('/').includes('..') || typeof e.reason !== 'string' || !e.reason.trim())) throw new Error('T0 の行が不正');
    context.tests = unique([...tests, ...context.always.tests.map(e => e.file)]);
    context.map = json(join(root, APP, 'test/select-map.json'));
    context.matrix = json(join(root, APP, 'test/pg-matrix.json'));
    for (const folder of ['src', 'scripts', 'test']) {
      for (const file of walk(root, APP + folder)) {
        if (!/\.(?:mjs|js|jsx)$/.test(file)) continue;
        const source = readFileSync(join(root, file), 'utf8');
        context.sources[file] = source;
        const parsed = imports(source, file);
        if (parsed.includes('@unresolved')) context.unresolved.push(file);
        const deps = parsed.filter(f => f !== '@unresolved');
        context.graph.set(file, deps);
        for (const dep of deps) {
          if (!context.reverse.has(dep)) context.reverse.set(dep, []);
          context.reverse.get(dep).push(file);
        }
      }
    }
    context.inventory = unique([...Object.keys(context.sources), ...walk(root, APP + 'src'),
      ...['migrations', 'pg'].flatMap(f => existsSync(join(root, APP, f)) ? walk(root, APP + f) : []),
      ...['package.json', 'package-lock.json', APP + 'package.json', APP + 'package-lock.json', APP + 'test/pg-matrix.json']
        .filter(f => existsSync(join(root, f)))]);
  } catch (error) {
    context.error = error.message;
    if (existsSync(join(root, 'scripts/ops'))) context.tests = unique([...context.tests, ...walk(root, 'scripts/ops').filter(f => f.endsWith('.test.mjs'))]);
  }
  return context;
}

export function sourceRiskReasons(file, source = '') {
  const path = local(file);
  const reasons = [];
  if (/^(?:migrations|pg)\//.test(path) || /\.sql$/i.test(path)
    || /(?:^|\/)(?:[^/]+-store|db|pg-db|db-errors|lite-sql|test-db|test-pg|select-tests|js-scan|money-words)\.mjs$/.test(path)
    || /(?:^|\/)(?:package\.json|package-lock\.json|npm-shrinkwrap\.json|yarn\.lock|pnpm-lock\.yaml|pg-matrix\.json)$/.test(path)) reasons.push('name');
  if (file === HUB) reasons.push('identity-entry');
  if (path.startsWith('src/') && /\.(?:mjs|js|jsx)$/.test(path)) {
    const {masked, code, strings} = scanJs(source);
    if (mentionsMoney(masked) || strings.some(s => s.expressions?.some(e => mentionsMoney(scanJs(e.value).masked)))) reasons.push('money');
    // role を使う識別子を広めに拾う。名前で領域を決めず、役割による絞り込みを保守的に扱う。
    if (/\.\s*get\s*\(\s*['"]identity['"]\s*\)/.test(code) || /\b\w*role\w*\b/i.test(masked)) reasons.push('identity-role');
    if (/\bconsole\s*\./.test(masked) || /\b(?:logger|auditLog|writeAudit|logEvent)\b/.test(masked)) reasons.push('logging');
    if (strings.some(s => /^\s*(?:SELECT\s|WITH\s[\s\S]*\bSELECT\b|INSERT\s|UPDATE\s|DELETE\s|REPLACE\s|CREATE\s|ALTER\s|DROP\s|PRAGMA\s)/.test(s.value))) reasons.push('sql');
  }
  return reasons;
}

export function r3Files(context) {
  const result = {};
  for (const file of context.inventory ?? []) {
    const reasons = sourceRiskReasons(file, context.sources[file]);
    if (reasons.length) result[file] = reasons;
  }
  // T0 の金額・権限の試験からたどる。app は両方向とも境界。
  const seen = new Set();
  const visit = file => {
    if (file === HUB || seen.has(file)) return;
    seen.add(file);
    if (file.startsWith(APP + 'src/')) result[file] = unique([...(result[file] ?? []), 'T0-import']);
    for (const dep of context.graph.get(file) ?? []) visit(dep);
  };
  for (const entry of context.always?.tests ?? []) {
    if (/\/(?:money-rules|session-org|shell-org|org-switch-shell|req5-admin-visibility(?:-sqlite)?|cloud-security|royalty-(?:model|statement|review-fixes)|tax-(?:oracle-independent|ledger)|fictional-committee(?:-sqlite)?)\.test\.mjs$/.test(entry.file)) visit(entry.file);
  }
  return result;
}

export function matches(pattern, file) {
  const parts = pattern.split('**').map(part => part.split('*').map(s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('[^/]*'));
  return new RegExp('^' + parts.join('.*') + '$').test(file);
}

function validate(context) {
  if (context.error) throw new Error(context.error);
  const {map, always, matrix, root} = context;
  if (map?.version !== 1 || map.pathBase !== 'core' || !Array.isArray(map.inputs) || !Array.isArray(map.routes)) throw new Error('対応表の形式が不正');
  if (mapCoverageViolations(map).length) throw new Error('対応表の入力の種類が欠けている');
  if (always?.pathBase !== 'core' || !always.tests?.length || !matrix?.sqliteOnly || !Array.isArray(matrix.pending)) throw new Error('T0/PG 一覧が不正');
  for (const row of map.inputs) {
    if (typeof row.pattern !== 'string' || !Array.isArray(row.tests) || !row.tests.length) throw new Error('対応表の行が不正');
    for (const pattern of row.tests) if (!context.tests.some(f => matches(pattern, f))) throw new Error(`対応する試験が無い: ${pattern}`);
  }
  // PR2 は空の URL 対応表だけを受け付ける。PR3 の実装前に黙って行を捨てない。
  if (map.routes.length) throw new Error('URL→route 対応は PR3 で実装する');
  for (const file of context.tests) if (!existsSync(join(root, file))) throw new Error(`試験が無い: ${file}`);
}

function git(root, args) { return execFileSync('git', args, {cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 16 * 1024 * 1024}); }
export function changedFiles(root, base = 'origin/main') {
  // --no-renames で改名の旧名と新名の両方を拾い、削除も残す。-z で空白や日本語を保つ。
  return unique([
    git(root, ['diff', '--name-only', '--no-renames', '-z', `${base}...HEAD`, '--']),
    git(root, ['diff', '--name-only', '--no-renames', '-z', 'HEAD', '--']),
    git(root, ['ls-files', '--others', '--exclude-standard', '-z']),
  ].flatMap(s => s.split('\0').filter(Boolean)));
}

function previousRisk(context, files, base) {
  const result = {};
  const refs = unique(['HEAD', git(context.root, ['merge-base', base ?? 'origin/main', 'HEAD']).trim()]);
  for (const ref of refs) {
    const tracked = new Set(git(context.root, ['ls-tree', '-r', '--name-only', '-z', ref]).split('\0'));
    for (const file of files) if (file.startsWith(APP + 'src/') && tracked.has(file)) {
      result[file] = unique([...(result[file] ?? []), ...sourceRiskReasons(file, git(context.root, ['show', `${ref}:${file}`]))]);
    }
  }
  return result;
}

function distances(context, files, boundary) {
  const dist = new Map(files.map(f => [f, 0]));
  const queue = [...files];
  for (let i = 0; i < queue.length; i++) {
    const file = queue[i];
    if (boundary && file === HUB) continue;
    for (const parent of context.reverse.get(file) ?? []) if (!dist.has(parent)) {
      dist.set(parent, dist.get(file) + 1);
      queue.push(parent);
    }
  }
  return dist;
}

export function selectTests(options = {}) {
  const context = options.context ?? createContext({root: options.root});
  const reasons = Object.fromEntries(context.tests.map(f => [f, []]));
  const selected = new Set();
  const result = {version: 1, pathBase: 'core', full: false, fullReasons: [], files: [], sha: null,
    selected: [], omitted: [], reasons, sampled: [], scores: {}, R: null, remainingR: null,
    threshold: 0.02, thresholdStatus: 'provisional: 影の期間後に決定', prior: {n: 0, failures: 0, q: 0.1}, sampleRate: 0.2,
    riskNote: 'R は依存の強さ×事前値の和。実績に基づく確率ではない。初月20%を継続し、変更は実績のレビュー後。', r3: {}};
  const add = (file, reason) => { selected.add(file); if (!reasons[file].includes(reason)) reasons[file].push(reason); };
  const full = reason => { result.full = true; result.fullReasons.push(reason); for (const file of context.tests) add(file, reason); };
  try {
    validate(context);
    result.r3 = r3Files(context);
    result.files = options.files === undefined ? changedFiles(context.root, options.base) : unique(options.files.map(file => {
      const path = slash(file).replace(/^\.\//, '');
      if (path.startsWith(APP) || path === 'AGENTS.md' || path === 'package.json' || path === 'package-lock.json' || path.startsWith('.claude/') || path.startsWith('scripts/ops/') || path.startsWith('docs/platform/')) return path;
      if (path.startsWith('/') || /^[A-Za-z]:/.test(path) || path.split('/').includes('..')) throw new Error('パスはアプリまたは core 相対で指定する');
      return APP + path;
    }));
    result.sha = options.sha ?? git(context.root, ['rev-parse', 'HEAD']).trim();
    if (typeof result.sha !== 'string' || !result.sha.trim()) throw new Error('SHA が無い');
    for (const entry of context.always.tests) add(entry.file, 'T0: ' + entry.reason);
    for (const file of context.unresolved) {
      const reach = distances(context, [file], false);
      if (result.files.includes(file) || (result.files.length && context.tests.some(f => reach.has(f)))) full(`R7: 非リテラル import ${file}`);
    }
    if (options.full || options.labels?.includes('full-test') || (options.message ?? git(context.root, ['log', '-1', '--format=%B'])).includes('[full]')) full('R7: full-test / [full] / --full');
    const near = distances(context, result.files, true);
    const across = distances(context, result.files, false);
    const previous = options.files === undefined ? previousRisk(context, result.files, options.base) : {};
    for (const file of result.files) {
      const risk = unique([...(result.r3[file] ?? []), ...(previous[file] ?? []), ...sourceRiskReasons(file, context.sources[file])]);
      if (risk.length) full(`R3: ${file} (${risk.join(', ')})`);
      const rows = context.map.inputs.filter(row => matches(row.pattern, file));
      for (const row of rows) for (const test of context.tests) if (row.tests.some(pattern => matches(pattern, test))) add(test, `R2: map ${row.pattern}`);
      const reachable = distances(context, [file], false);
      if (!risk.length && !rows.length && (!existsSync(join(context.root, file)) || !context.tests.some(test => reachable.has(test)))) full(`R7: 対応が無い ${file}`);
    }
    for (const file of context.tests) {
      const d = near.get(file);
      const mapped = reasons[file].some(r => r.startsWith('R2'));
      result.scores[file] = mapped || d <= 1 ? 1 : d <= 3 ? 0.5 : across.has(file) && !near.has(file) ? 0.02 : 0;
      if (d !== undefined && file !== HUB) add(file, `R2: import distance=${d}`);
      if (heavy(file)) {
        const related = result.files.some(f => f === file || /(?:^|\/)(?:seed-|demo-|measure-)/.test(f)) && across.has(file);
        if (related) add(file, 'R4: 関係する seed/demo/measure の変更');
        else if (!result.full && !reasons[file].some(r => r.startsWith('T0'))) {
          selected.delete(file);
          reasons[file].push('R4: 関係する seed/demo の変更なし（R5/R6 の安全網は適用）');
        }
      }
    }
    const candidates = context.tests.filter(f => !selected.has(f));
    // 履歴なしなので等重み。SHA とパスのハッシュ順で、OS・列挙順に依存しない。
    const rank = file => createHash('sha256').update(result.sha + '\0' + file).digest('hex');
    result.sampled = candidates.sort((a, b) => rank(a).localeCompare(rank(b)) || a.localeCompare(b))
      .slice(0, Math.min(candidates.length, Math.max(5, Math.ceil(candidates.length * result.sampleRate))));
    for (const file of result.sampled) add(file, 'R5: SHA を種に抜き取り');
    result.R = context.tests.filter(f => !selected.has(f)).reduce((sum, file) => sum + result.scores[file] * result.prior.q, 0);
    if (result.R > result.threshold) full(`R6: R=${result.R} > 暫定閾値 ${result.threshold}`);
  } catch (error) { full('R7: ' + error.message); }
  result.selected = [...selected].sort();
  result.omitted = context.tests.filter(f => !selected.has(f));
  for (const file of result.omitted) if (!reasons[file].length) reasons[file].push('省略: R2 の境界内の依存・対応表の一致なし。R5 の抜き取り対象外');
  result.remainingR = result.full ? 0 : result.R;
  return result;
}

export function executionPlan(result, context, mode) {
  const excluded = new Set((context.matrix?.sqliteOnly ?? []).map(e => APP + 'test/' + e.file));
  return {app: result.selected.filter(f => f.startsWith(APP) && (mode !== 'pg' || !excluded.has(f))).map(local),
    core: result.selected.filter(f => !f.startsWith(APP))};
}

function run(args, cwd) {
  const child = spawnSync(process.execPath, args, {cwd, stdio: 'inherit'});
  return child.error || child.signal ? 1 : child.status ?? 1;
}
function main() {
  const options = {};
  let format = process.argv.includes('--json') ? 'json' : process.argv.includes('--list') ? 'list' : 'summary', mode;
  try {
    const args = process.argv.slice(2);
    for (let i = 0; i < args.length; i++) {
      const arg = args[i];
      if (arg === '--json' || arg === '--list') format = arg.slice(2);
      else if (arg === '--full') options.full = true;
      else if (arg === '--files') {
        options.files ??= [];
        while (args[i + 1] && !args[i + 1].startsWith('--')) options.files.push(args[++i]);
      } else if (['--base', '--sha', '--run', '--label'].includes(arg)) {
        const value = args[++i];
        if (!value || value.startsWith('--')) throw new Error(`値が無い: ${arg}`);
        if (arg === '--run') { if (!['sqlite', 'pg'].includes(value)) throw new Error('run は sqlite/pg'); mode = value; }
        else if (arg === '--label') (options.labels ??= []).push(value);
        else options[arg.slice(2)] = value;
      } else throw new Error(`不明な引数: ${arg}`);
    }
  } catch (error) { options.argumentError = error.message; }
  const context = createContext();
  if (options.argumentError) context.error = options.argumentError;
  const result = selectTests({...options, context});
  if (format === 'json') console.log(JSON.stringify(result, null, 2));
  else if (format === 'list') for (const file of result.selected) console.log(slash(relative(join(ROOT, APP), join(ROOT, file))));
  else {
    console.log(`選択 ${result.selected.length} / ${context.tests.length}、省略 ${result.omitted.length}、抜き取り ${result.sampled.length}、R=${result.R ?? 'unverified'}（確率ではない）`);
    for (const reason of result.fullReasons) console.log(reason);
    for (const file of context.tests) console.log(`${result.selected.includes(file) ? '選択' : '省略'} ${file}: ${result.reasons[file].join(' / ')}`);
  }
  if (mode) {
    if (mode === 'pg' && result.full && !process.env.ON_TEST_PG_URL) {
      console.error('全体が選ばれたため PGlite 全体は起動しない。SQLite 全体と CI の PostgreSQL 全体で確かめる');
      process.exitCode = 1; return;
    }
    if (mode === 'pg' && (!context.matrix?.sqliteOnly || context.error)) {
      console.error('PG の除外一覧を確認できない。SQLite 全体と CI の PostgreSQL 全体で確かめる');
      process.exitCode = 1; return;
    }
    const plan = executionPlan(result, context, mode);
    let status = 0;
    if (plan.app.length) status = run(mode === 'pg' ? ['scripts/test-pg.mjs', ...plan.app] : ['--test', '--test-concurrency=1', ...plan.app], join(ROOT, APP));
    if (plan.core.length) status = run(['--test', '--test-concurrency=1', ...plan.core], ROOT) || status;
    process.exitCode = status;
  }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
