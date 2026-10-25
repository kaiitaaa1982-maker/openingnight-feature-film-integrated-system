// 指標の出口（scripts/metrics.mjs。npm run metrics）と goal_check の試験。
// 期待値は goals/README.md の「出す指標」「goal_check」と、docs/rules/requirements.md の機能要件の表の決まりから決める。
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, writeFileSync, mkdirSync, rmSync, readFileSync, existsSync} from 'node:fs';
import {join, dirname} from 'node:path';
import {tmpdir} from 'node:os';
import {spawnSync, execFileSync} from 'node:child_process';
import {APP_DIR, COLLECTORS, UsageError, countDeclaredTests, countDebt, frRows, frSince, gitTree, goalCheck, measure, parseGoal,
  resolveOptions, runNodeTests, runPlan, runTests, staticMetrics, summary, testPlan, workingTree} from '../scripts/metrics.mjs';
import {summarize} from '../scripts/metrics-reporter.mjs';

const collector = key => COLLECTORS.find(c => c.key === key);

// 読む元を、名前→中身の表から作る（パスはアプリ相対）
const memory = files => ({
  files: (dir, pattern) => Object.keys(files).filter(path => path.startsWith(`${dir}/`) && pattern.test(path)).sort(),
  read: path => files[path] ?? null,
});

const requirement = (domain, code, rows, extra = '') => [
  '---', `domain: ${domain}`, 'process: 架空の工程', `code: ${code}`, 'status: 下書き', '---', '',
  '## 機能要件', '', '| ID | 要件 | 状態 | 確かめる所 |', '|---|---|---|---|', ...rows, '', extra,
].join('\n');

function tempDir(t) {
  const dir = mkdtempSync(join(tmpdir(), 'on-metrics-test-'));
  t.after(() => rmSync(dir, {recursive: true, force: true}));
  return dir;
}

function writeFiles(root, files) {
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), {recursive: true});
    writeFileSync(join(root, path), text);
  }
}

test('FR の状態は機能要件の表の行だけを状態ごとに数え、領域と工程のファイルごとにも分ける', () => {
  const source = memory({
    'docs/requirements/README.md': requirement('core', 'X', ['| FR-CORE-X-001 | 数えない | テスト | test/a.test.mjs |']),
    'docs/requirements/revenue/receipt.md': requirement('revenue', 'RCPT', [
      '| FR-REV-RCPT-001 | 消し込むこと | テスト | `test/a.test.mjs` |',
      '| FR-REV-RCPT-002 | 見せること | 画面 | features/x.md |',
      '| FR-REV-RCPT-003 | 残すこと | 未検証 | src/x.mjs |',
      '| FR-REV-RCPT-004 | やめたこと | 廃止 | FR-REV-RCPT-001 へ |',
      '| FR-REV-RCPT-005 | 3列しかない | 未検証 |',
    ], ['```', '| FR-REV-RCPT-009 | 例 | テスト | test/x.test.mjs |', '```', '## テストの穴', '| ID | 点 |', '|---|---|', '| FR-REV-RCPT-001 | 期限 |'].join('\n')),
    'docs/requirements/settlement/close.md': requirement('settlement', 'CLOSE', [
      '| FR-SETL-CLOSE-001 | 締めること | 未検証 | src/y.mjs |',
      '| FR-SETL-CLOSE-002 | 締め直すこと | 未検証 | src/y.mjs |',
    ]),
  });
  assert.deepEqual(collector('fr').collect({source}), {
    files: 2,
    total: 6,
    byState: {テスト: 1, 画面: 1, 未検証: 3, 廃止: 1},
    byDomain: {revenue: {テスト: 1, 画面: 1, 未検証: 1, 廃止: 1}, settlement: {テスト: 0, 画面: 0, 未検証: 2, 廃止: 0}},
    byFile: {'revenue/receipt': {テスト: 1, 画面: 1, 未検証: 1, 廃止: 1}, 'settlement/close': {テスト: 0, 画面: 0, 未検証: 2, 廃止: 0}},
    broken: 1,
  });
});

test('基準からの FR の動きは、テストか画面から未検証へ戻った番号・消えた番号・足した番号を数える', () => {
  const base = [{id: 'FR-REV-A-001', state: 'テスト'}, {id: 'FR-REV-A-002', state: '画面'}, {id: 'FR-REV-A-003', state: '未検証'},
    {id: 'FR-REV-A-004', state: 'テスト'}, {id: 'FR-REV-A-005', state: 'テスト'}];
  const now = [{id: 'FR-REV-A-001', state: '未検証'}, {id: 'FR-REV-A-002', state: '未検証'}, {id: 'FR-REV-A-003', state: '未検証'},
    {id: 'FR-REV-A-004', state: '廃止'}, {id: 'FR-REV-A-006', state: '未検証'}, {id: 'FR-REV-A-007', state: 'テスト'}];
  assert.deepEqual(frSince(base, now), {
    regressed: 2, regressedIds: ['FR-REV-A-001', 'FR-REV-A-002'],
    removed: 1, removedIds: ['FR-REV-A-005'],
    added: 2, addedByState: {テスト: 1, 画面: 0, 未検証: 1, 廃止: 0},
  });
});

test('借りの数は、数はその値・配列は要素の数・入れ子は和で数え、note は数えない', () => {
  assert.equal(countDebt({a: ['x', 'y'], b: 3, c: {d: ['z'], e: 2}, note: '説明'}), 8);
  const source = memory({
    'test/alpha-debt.json': JSON.stringify({note: '返すべき借り', imports: {'src/a.mjs': ['src/b.mjs', 'src/c.mjs']}, sql: {'src/a.mjs': 4, 'src/d.mjs': 1}, env: {}}),
    'test/beta-debt.json': '﻿' + JSON.stringify({note: 'x', rootFiles: ['A.jsx', 'B.jsx', 'C.jsx']}),
    'test/pg-matrix.json': JSON.stringify({pending: [], sqliteOnly: []}),
  });
  const debt = collector('debt').collect({source});
  assert.deepEqual(debt, {
    total: 10,
    byFile: {alpha: {total: 7, kinds: {imports: 2, sql: 5, env: 0}}, beta: {total: 3, kinds: {rootFiles: 3}}},
  });
  // 種類は名前で並べる（借りの一覧のキーの順を入れ替えただけでは JSON が変わらない）
  assert.deepEqual(Object.keys(debt.byFile.alpha.kinds), ['env', 'imports', 'sql']);
});

test('書いた試験の数は、そのまま呼んだ test と it を数え、skip・todo は分け、コメント・文字列・re.test・t.test は数えない', () => {
  const text = [
    "import test from 'node:test';",
    "test('一', () => {});",
    "it('二', () => {});",
    "describe('組', () => { it('三', () => {}); });",
    "for (const n of [1, 2]) test(`四 ${n}`, () => {});",
    "test.skip('飛ばす', () => {}); test.todo('あとで');",
    "// test('コメント', () => {})",
    "const s = \"test('文字列')\"; /x/.test(s); RE.test(s);",
    "test('五', async t => { await t.test('中', () => {}); });",
    "function helper() { return test('六', () => {}); }",
  ].join('\n');
  assert.deepEqual(countDeclaredTests(text), {declared: 6, skipOrTodo: 2});
  const source = memory({'test/a.test.mjs': text, 'test/b.test.mjs': "test('七', () => {});", 'test/a-fixture.mjs': "test('数えない', f);",
    'test/pg-matrix.json': JSON.stringify({pending: [{file: 'x.test.mjs'}], sqliteOnly: [{file: 'y.test.mjs'}, {file: 'z.test.mjs'}]})});
  assert.deepEqual(collector('tests').collect({source}), {files: 2, declared: 7, declaredSkipOrTodo: 2, pgPending: 1, sqliteOnly: 2});
});

const GOAL = [
  '---', 'title: 架空の目標', 'baseline: abc1234', 'tests: test/a.test.mjs, test/b.test.mjs', 'engine: sqlite pg', '---', '',
  '## 目標', '| 表 | ではない |', '',
  '## goal_check', '',
  '| 指標 | 比べ方 | 値 | 種類 | 意味 |', '|---|---|---|---|---|',
  '| `testRun.sqlite.failed` | = | 0 | 守る | 試験の失敗0件 |',
  '| `debt.total` | <= | baseline | 守る | 借りが増えない |',
  '| `tests.declared` | >= | `baseline` | 守る |',
  '| `fr.byFile.revenue/receipt.未検証` | < | 3 | 伸ばす | 関係する FR |',
  '```', '| `x.y` | = | 9 | 守る | コードブロックの中は読まない |', '```',
  '', '## 記録', '| ターン | コミット |', '|---|---|', '| 1 | abc |',
].join('\n');

test('goal は frontmatter の試験・engine・基準と、goal_check の節の表の行だけを読む', () => {
  const goal = parseGoal(GOAL, 'goals/x.md');
  assert.deepEqual(goal, {
    file: 'goals/x.md', title: '架空の目標', baseline: 'abc1234', tests: ['test/a.test.mjs', 'test/b.test.mjs'], engines: ['sqlite', 'pg'],
    checks: [
      {metric: 'testRun.sqlite.failed', op: '=', value: 0, kind: '守る', note: '試験の失敗0件'},
      {metric: 'debt.total', op: '<=', value: 'baseline', kind: '守る', note: '借りが増えない'},
      {metric: 'tests.declared', op: '>=', value: 'baseline', kind: '守る'},
      {metric: 'fr.byFile.revenue/receipt.未検証', op: '<', value: 3, kind: '伸ばす', note: '関係する FR'},
    ],
    problems: [],
  });
  assert.equal(parseGoal(GOAL.replace('tests: test/a.test.mjs, test/b.test.mjs', 'tests: changed'), 'g').tests, 'changed');
});

test('goal_check は全部の行が通れば PASS、1行でも落ちれば FAIL。指標が無い行と基準の値が無い行は落とす', () => {
  const goal = parseGoal(GOAL, 'goals/x.md');
  const result = {
    metrics: {testRun: {sqlite: {failed: 0}}, debt: {total: 10}, tests: {declared: 20}, fr: {byFile: {'revenue/receipt': {未検証: 2}}}},
    baseline: {metrics: {debt: {total: 10}, tests: {declared: 20}}},
  };
  const pass = goalCheck(goal, result);
  assert.equal(pass.verdict, 'PASS');
  assert.deepEqual(pass.guards, {passed: 3, total: 3});
  assert.deepEqual(pass.targets, {passed: 1, total: 1});
  assert.deepEqual(pass.checks[1], {metric: 'debt.total', op: '<=', value: 'baseline', expected: 10, actual: 10, kind: '守る', pass: true});

  // 境界: 借りが基準より1つ増える・FR が閾値ちょうど（< 3 に 3）
  const over = goalCheck(goal, {...result, metrics: {...result.metrics, debt: {total: 11}, fr: {byFile: {'revenue/receipt': {未検証: 3}}}}});
  assert.equal(over.verdict, 'FAIL');
  assert.deepEqual(over.checks.filter(c => !c.pass).map(c => c.metric), ['debt.total', 'fr.byFile.revenue/receipt.未検証']);
  assert.deepEqual(over.guards, {passed: 2, total: 3});

  // 試験を流していない（testRun が null）なら、試験の失敗0件の行は通らない
  const notRun = goalCheck(goal, {...result, metrics: {...result.metrics, testRun: null}});
  assert.equal(notRun.verdict, 'FAIL');
  assert.deepEqual(notRun.checks[0], {metric: 'testRun.sqlite.failed', op: '=', value: 0, expected: 0, actual: null, kind: '守る', pass: false, reason: '指標が無いか数でない'});

  // 基準が無いと baseline の行は通らない
  const noBase = goalCheck(goal, {...result, baseline: null});
  assert.deepEqual(noBase.checks.filter(c => !c.pass).map(c => [c.metric, c.reason]), [['debt.total', '基準の値が無い'], ['tests.declared', '基準の値が無い']]);

  // 行が無い goal は PASS にしない
  assert.equal(goalCheck({file: 'g', checks: []}, result).verdict, 'FAIL');
});

test('goal の書き方の誤りは、行ごとの問題として返す', () => {
  const broken = GOAL
    .replace('| `testRun.sqlite.failed` | = | 0 | 守る | 試験の失敗0件 |', '| `testRun.sqlite.failed` | == | 0 | 守る |')
    .replace('| `debt.total` | <= | baseline | 守る | 借りが増えない |', '| `debt.total` | <= | たくさん | 守る |')
    .replace('| `tests.declared` | >= | `baseline` | 守る |', '| `tests.declared` | >= | 1 | 大事 |')
    .replace('| `fr.byFile.revenue/receipt.未検証` | < | 3 | 伸ばす | 関係する FR |', '| fr..total | < | 3 |')
    .replace('engine: sqlite pg', 'engine: sqlite mysql');
  assert.deepEqual(parseGoal(broken, 'g').problems, [
    'g: 比べ方は = <= >= < > のどれか: ==',
    'g: 値は数か baseline: たくさん',
    'g: 種類は 守る か 伸ばす: 大事',
    'g: 4列か5列（指標・比べ方・値・種類・意味）でない行: | fr..total | < | 3 |',
    'g: engine は sqlite・pg: sqlite mysql',
  ]);
  assert.deepEqual(parseGoal('# 目標だけ\n', 'g').problems, ['g: 「## goal_check」の節が無い']);
  assert.deepEqual(parseGoal('## goal_check\n\n| 指標 | 比べ方 | 値 | 種類 |\n|---|---|---|---|\n', 'g').problems, ['g: goal_check の行が無い']);
  assert.deepEqual(parseGoal('## goal_check\n| a b | = | 1 | 守る |\n', 'g').problems, ['g: 指標の書き方が違う（metrics の JSON の . 区切りの道）: a b']);
});

test('measure へ渡す試験・engine・基準は、コマンドの引数、goal の frontmatter、既定の順に決める', () => {
  const goal = parseGoal(GOAL, 'goals/x.md');
  assert.deepEqual(resolveOptions({}, goal), {tests: ['test/a.test.mjs', 'test/b.test.mjs'], engines: ['sqlite', 'pg'], baseline: 'abc1234'});
  assert.deepEqual(resolveOptions({tests: 'changed', engines: ['sqlite'], baseline: 'def5678'}, goal), {tests: 'changed', engines: ['sqlite'], baseline: 'def5678'});
  assert.deepEqual(resolveOptions({engines: ['pg']}, goal), {tests: ['test/a.test.mjs', 'test/b.test.mjs'], engines: ['pg'], baseline: 'abc1234'});
  assert.deepEqual(resolveOptions({}, null), {tests: null, engines: ['sqlite'], baseline: null});
  assert.deepEqual(resolveOptions({}, parseGoal('## goal_check\n| tests.files | >= | 1 | 守る |\n', 'g')), {tests: null, engines: ['sqlite'], baseline: null});
  // 値に baseline を使う goal は、frontmatter か引数のどちらかに基準が要る
  const noBase = {...goal, baseline: null};
  assert.throws(() => resolveOptions({}, noBase),
    error => error instanceof UsageError && error.message === 'goals/x.md: 値に baseline を使うなら、frontmatter の baseline か --baseline で基準のコミットを渡す');
  assert.equal(resolveOptions({baseline: 'HEAD'}, noBase).baseline, 'HEAD');
});

test('reporter は全体の件数と、落ちた試験の名前を並べて返す', () => {
  const events = [
    {type: 'test:fail', data: {file: '/w/test/b.test.mjs', name: '後'}},
    {type: 'test:summary', data: {file: '/w/test/b.test.mjs', counts: {tests: 1, passed: 0, failed: 1}}},
    {type: 'test:fail', data: {file: '/w/test/a.test.mjs', name: '前'}},
    {type: 'test:fail', data: {file: '/w/test/a.test.mjs', name: '前'}},
    {type: 'test:fail', data: {file: '/w/test/c.test.mjs', name: 'test\\c.test.mjs'}}, // 読み込みに失敗した本（Windows の区切り）
    {type: 'test:fail', data: {name: 'ファイルの無い失敗'}},
    {type: 'test:summary', data: {counts: {tests: 9, passed: 5, failed: 4, cancelled: 0, skipped: 1, todo: 1, suites: 3}}},
  ];
  assert.deepEqual(summarize(events, {cwd: '/w'}), {
    counts: {tests: 9, passed: 5, failed: 4, cancelled: 0, skipped: 1, todo: 1},
    failures: ['test/a.test.mjs › 前', 'test/b.test.mjs › 後', 'test/c.test.mjs', 'ファイルの無い失敗'],
  });
  assert.deepEqual(summarize([], {cwd: '/w'}), {counts: null, failures: []});
});

test('試験の結果は node --test を流した件数と落ちた試験の名前で、2回流して同じ値になる', t => {
  const dir = tempDir(t);
  writeFiles(dir, {
    'a.test.mjs': [
      "import test from 'node:test';", "import assert from 'node:assert/strict';",
      "test('通る', () => {});", "test('落ちる', () => { assert.equal(1, 2); });",
      "test('飛ばす', {skip: '架空の理由'}, () => {});", "test('あとで', {todo: '架空の理由'}, () => {});",
    ].join('\n'),
    'b.test.mjs': "import test from 'node:test';\nthrow new Error('読み込みで落ちる');\n",
  });
  const run = () => runNodeTests({cwd: dir, files: ['a.test.mjs', 'b.test.mjs'], env: {ON_TEST_DB: 'sqlite'}, progress: false});
  const first = run();
  assert.deepEqual(first, {
    counts: {tests: 5, passed: 1, failed: 2, cancelled: 0, skipped: 1, todo: 1},
    failures: ['a.test.mjs › 落ちる', 'b.test.mjs'],
    exitCode: 1,
  });
  assert.deepEqual(run(), first);
  assert.deepEqual(runNodeTests({cwd: dir, files: []}), {counts: {tests: 0, passed: 0, failed: 0, cancelled: 0, skipped: 0, todo: 0}, failures: [], exitCode: 0});
});

const IMPORTS = "import test from 'node:test';\nimport assert from 'node:assert/strict';";
const counts = (tests, passed, failed) => ({tests, passed, failed, cancelled: 0, skipped: 0, todo: 0});

// 流す先は ON_TEST_PG_URL で決まる。試験の間は外し（npm run test:pg が本物の PostgreSQL へ流すときも）、終わりに戻す
function withoutPgUrl(t) {
  const saved = process.env.ON_TEST_PG_URL;
  delete process.env.ON_TEST_PG_URL;
  t.after(() => {
    if (saved === undefined) delete process.env.ON_TEST_PG_URL;
    else process.env.ON_TEST_PG_URL = saved;
  });
}

// 試験を流す架空のアプリ。core のルート（root）の下の apps/integrated-prototype に置く。
// engine.test.mjs は ON_TEST_DB が pg のときだけ落ち、only-sqlite.test.mjs（sqliteOnly）は ON_TEST_DB が sqlite であることを確かめる。
// 前処理は prepare の真偽で通るか落ちる
function runnableApp(t, {prepare}) {
  const root = tempDir(t);
  const appDir = join(root, 'apps', 'integrated-prototype');
  writeFiles(appDir, {
    'scripts/prepare-test-assets.mjs': `process.exitCode = ${prepare ? 0 : 1};\n`,
    'test/pg-matrix.json': JSON.stringify({pending: [], sqliteOnly: [{file: 'only-sqlite.test.mjs', reason: '架空の SQLite だけの本'}]}),
    'test/engine.test.mjs': `${IMPORTS}\ntest('PostgreSQL では落ちる', () => { assert.notEqual(process.env.ON_TEST_DB, 'pg'); });\n`,
    'test/only-sqlite.test.mjs': `${IMPORTS}\ntest('SQLite で流れる', () => { assert.equal(process.env.ON_TEST_DB, 'sqlite'); });\n`,
  });
  return {root, appDir};
}

test('挙げた試験は、PostgreSQL では ON_TEST_DB を pg にして sqliteOnly の本を除いて流し、流した先を PGlite と出す', t => {
  withoutPgUrl(t);
  const {appDir} = runnableApp(t, {prepare: false});
  assert.deepEqual(runTests({tests: ['test/only-sqlite.test.mjs', 'test/engine.test.mjs'], engines: ['sqlite', 'pg']}, {appDir, progress: false}), {
    selection: 'files',
    prepared: false,
    sqlite: {target: 'sqlite', fileCount: 2, ...counts(2, 2, 0), exitCode: 0, failures: [], files: ['test/engine.test.mjs', 'test/only-sqlite.test.mjs']},
    pg: {target: 'pglite', fileCount: 1, ...counts(1, 0, 1), exitCode: 1, failures: ['test/engine.test.mjs › PostgreSQL では落ちる'], files: ['test/engine.test.mjs']},
  });
});

test('全部の試験（all）は SQLite で test/*.test.mjs を流し、ON_TEST_PG_URL が無ければ PostgreSQL では流さない', t => {
  withoutPgUrl(t);
  const {appDir} = runnableApp(t, {prepare: true});
  assert.throws(() => runTests({tests: 'all', engines: ['sqlite', 'pg']}, {appDir, progress: false}),
    error => error instanceof UsageError && error.message.startsWith('全部の試験を PGlite では流さない'));
  assert.deepEqual(runTests({tests: 'all', engines: ['sqlite']}, {appDir, progress: false}), {
    selection: 'all',
    prepared: true,
    sqlite: {target: 'sqlite', fileCount: 2, ...counts(2, 2, 0), exitCode: 0, failures: [], files: ['test/engine.test.mjs', 'test/only-sqlite.test.mjs']},
  });
  // 本物の PostgreSQL（ON_TEST_PG_URL）があれば、sqliteOnly を除いて全部を計画する（ここでは流さない）
  process.env.ON_TEST_PG_URL = 'postgres://metrics-test.invalid/none';
  assert.deepEqual(testPlan({tests: 'all', engines: ['pg']}, {appDir}), {pg: [{cwd: appDir, prefix: '', files: ['test/engine.test.mjs']}]});
});

test('差分から選ぶ（changed）は、アプリの本と core の本を別の群にし、PostgreSQL ではアプリの本から sqliteOnly を除いて流す', t => {
  withoutPgUrl(t);
  const {root, appDir} = runnableApp(t, {prepare: true});
  const selected = ['apps/integrated-prototype/test/engine.test.mjs', 'apps/integrated-prototype/test/only-sqlite.test.mjs', 'scripts/ops/core.test.mjs'];
  const selectChanged = full => () => ({context: {matrix: {sqliteOnly: [{file: 'only-sqlite.test.mjs'}]}}, result: {full, selected}});
  assert.deepEqual(testPlan({tests: 'changed', engines: ['sqlite', 'pg']}, {appDir, selectChanged: selectChanged(false)}), {
    sqlite: [{cwd: appDir, prefix: '', files: ['test/engine.test.mjs', 'test/only-sqlite.test.mjs']}, {cwd: root, prefix: '../../', files: ['scripts/ops/core.test.mjs']}],
    pg: [{cwd: appDir, prefix: '', files: ['test/engine.test.mjs']}],
  });
  // 差分から全部が選ばれたら、PGlite では流さない。SQLite だけなら計画する
  assert.throws(() => testPlan({tests: 'changed', engines: ['sqlite', 'pg']}, {appDir, selectChanged: selectChanged(true)}),
    error => error instanceof UsageError && error.message.startsWith('差分から全部が選ばれたので PGlite では流さない'));
  assert.deepEqual(Object.keys(testPlan({tests: 'changed', engines: ['sqlite']}, {appDir, selectChanged: selectChanged(true)})), ['sqlite']);
});

test('群が2つ（アプリと core）なら、件数は群の和、終了コードは群の最大、落ちた試験の名前は群の prefix を付けて並べ替える', t => {
  const root = tempDir(t);
  const appDir = join(root, 'apps', 'integrated-prototype');
  const fails = name => `${IMPORTS}\ntest('${name}', () => { assert.equal(1, 2); });\n`;
  const passes = name => `${IMPORTS}\ntest('${name}', () => {});\n`;
  writeFiles(root, {
    'apps/integrated-prototype/test/app.test.mjs': fails('アプリで落ちる'),
    'apps/integrated-prototype/test/app-ok.test.mjs': passes('アプリで通る'),
    'scripts/core.test.mjs': fails('core で落ちる'),
    'scripts/core-ok.test.mjs': passes('core で通る'),
  });
  const app = files => ({cwd: appDir, prefix: '', files});
  const core = files => ({cwd: root, prefix: '../../', files});
  // 両方の群で落ちる。群の順に並べるとアプリの名前が先になるが、並べ替えると ../../ の core が先になる
  assert.deepEqual(runPlan({sqlite: [app(['test/app.test.mjs']), core(['scripts/core.test.mjs', 'scripts/core-ok.test.mjs'])]}, {progress: false}), {
    sqlite: {target: 'sqlite', fileCount: 3, ...counts(3, 1, 2), exitCode: 1,
      failures: ['../../scripts/core.test.mjs › core で落ちる', 'test/app.test.mjs › アプリで落ちる'],
      files: ['test/app.test.mjs', '../../scripts/core.test.mjs', '../../scripts/core-ok.test.mjs']},
  });
  // アプリの群は通り、後ろの core の群だけ落ちる
  assert.deepEqual(runPlan({sqlite: [app(['test/app-ok.test.mjs']), core(['scripts/core.test.mjs'])]}, {progress: false}), {
    sqlite: {target: 'sqlite', fileCount: 2, ...counts(2, 1, 1), exitCode: 1,
      failures: ['../../scripts/core.test.mjs › core で落ちる'], files: ['test/app-ok.test.mjs', '../../scripts/core.test.mjs']},
  });
});

// 架空の小さなアプリを git に入れ、コミットの中身と作業中のファイルを読み比べる
function fakeApp(t) {
  const dir = tempDir(t);
  const files = {
    'docs/requirements/revenue/receipt.md': requirement('revenue', 'RCPT', [
      '| FR-REV-RCPT-001 | 消し込むこと | テスト | `test/a.test.mjs` |',
      '| FR-REV-RCPT-002 | 残すこと | 未検証 | src/x.mjs |',
    ]),
    'docs/requirements/settlement/close.md': requirement('settlement', 'CLOSE', ['| FR-SETL-CLOSE-001 | 締めること | 画面 | features/x.md |']),
    'test/a.test.mjs': "import test from 'node:test';\ntest('FR-REV-RCPT-001 消し込む', () => {});\n",
    'test/b.test.mjs': "import test from 'node:test';\ntest('二つ目', () => {});\ntest('三つ目', () => {});\n",
    'test/pg-matrix.json': JSON.stringify({pending: [], sqliteOnly: []}),
    'test/alpha-debt.json': JSON.stringify({note: 'x', sql: {'src/a.mjs': 2}}),
  };
  writeFiles(dir, files);
  const git = args => execFileSync('git', ['-c', 'user.name=metrics-test', '-c', 'user.email=metrics-test@example.invalid', '-c', 'core.autocrlf=false', ...args], {cwd: dir, stdio: 'pipe'});
  git(['init', '-q']);
  git(['add', '-A']);
  git(['commit', '-q', '-m', 'base']);
  return {dir, files};
}

test('基準のコミットは git の中身から、作業中のファイルと同じ読み方で数える', t => {
  const {dir, files} = fakeApp(t);
  const committed = staticMetrics(memory(files));
  assert.deepEqual(staticMetrics(gitTree('HEAD', {appDir: dir})), committed);
  assert.deepEqual(staticMetrics(workingTree(dir)), committed);
  assert.deepEqual(committed.tests, {files: 2, declared: 3, declaredSkipOrTodo: 0, pgPending: 0, sqliteOnly: 0});
  assert.deepEqual(frRows(gitTree('HEAD', {appDir: dir})).rows.map(r => r.id), ['FR-REV-RCPT-001', 'FR-REV-RCPT-002', 'FR-SETL-CLOSE-001']);
  assert.throws(() => gitTree('no-such-ref', {appDir: dir}), {message: '基準のコミットが無い: no-such-ref'});
});

test('基準と比べると、テストだった FR が未検証へ戻ったことと、試験の本数・借りの増減が goal_check で落ちる', async t => {
  const {dir} = fakeApp(t);
  const path = join(dir, 'docs/requirements/revenue/receipt.md');
  writeFileSync(path, readFileSync(path, 'utf8').replace('| FR-REV-RCPT-001 | 消し込むこと | テスト |', '| FR-REV-RCPT-001 | 消し込むこと | 未検証 |'));
  writeFileSync(join(dir, 'test/alpha-debt.json'), JSON.stringify({note: 'x', sql: {'src/a.mjs': 3}}));
  writeFileSync(join(dir, 'test/a.test.mjs'), "import test from 'node:test';\n");
  const result = await measure({baseline: 'HEAD'}, {appDir: dir});
  assert.equal(result.dirty, true);
  assert.equal(result.baseline.commit, result.commit);
  assert.equal(result.metrics.testRun, null);
  assert.deepEqual(result.metrics.fr.sinceBaseline, {regressed: 1, regressedIds: ['FR-REV-RCPT-001'], removed: 0, removedIds: [], added: 0,
    addedByState: {テスト: 0, 画面: 0, 未検証: 0, 廃止: 0}});
  const goal = parseGoal(['## goal_check', '| 指標 | 比べ方 | 値 | 種類 |', '|---|---|---|---|',
    '| fr.sinceBaseline.regressed | = | 0 | 守る |', '| tests.declared | >= | baseline | 守る |', '| debt.total | <= | baseline | 守る |',
    '| fr.byState.テスト | >= | 0 | 伸ばす |'].join('\n'), 'g');
  const check = goalCheck(goal, result);
  assert.equal(check.verdict, 'FAIL');
  assert.deepEqual(check.checks.map(c => [c.metric, c.expected, c.actual, c.pass]), [
    ['fr.sinceBaseline.regressed', 0, 1, false], ['tests.declared', 3, 2, false], ['debt.total', 2, 3, false], ['fr.byState.テスト', 0, 0, true]]);
});

const cli = args => spawnSync(process.execPath, ['scripts/metrics.mjs', ...args], {cwd: APP_DIR, encoding: 'utf8'});

test('npm run metrics は同じコミットで2回流して同じ JSON を出す（標準出力は JSON だけ）', () => {
  const first = cli([]);
  const second = cli([]);
  assert.equal(first.status, 0, first.stderr);
  assert.equal(second.stdout, first.stdout);
  const json = JSON.parse(first.stdout);
  assert.deepEqual(Object.keys(json), ['schema', 'commit', 'dirty', 'metrics', 'baseline', 'goalCheck']);
  assert.deepEqual(Object.keys(json.metrics), ['tests', 'fr', 'debt', 'testRun']);
  assert.equal(json.metrics.testRun, null);
  assert.deepEqual(json.metrics, {...staticMetrics(workingTree(APP_DIR)), testRun: null});
});

test('--goal は PASS で 0、FAIL で 1、goal の書き方の誤りで 2 を返す', t => {
  const dir = tempDir(t);
  let count = 0;
  const goal = rows => {
    const path = join(dir, `goal-${++count}.md`);
    writeFileSync(path, ['## goal_check', '| 指標 | 比べ方 | 値 | 種類 |', '|---|---|---|---|', ...rows].join('\n'));
    return path;
  };
  const pass = cli(['--goal', goal(['| tests.files | >= | 1 | 守る |', '| fr.total | >= | 1 | 伸ばす |'])]);
  assert.equal(pass.status, 0, pass.stderr);
  assert.equal(JSON.parse(pass.stdout).goalCheck.verdict, 'PASS');
  assert.match(pass.stderr, /goal_check: PASS（守る 1\/1・伸ばす 1\/1）/);
  const fail = cli(['--goal', goal(['| debt.total | < | 0 | 守る |'])]);
  assert.equal(fail.status, 1, fail.stderr);
  assert.equal(JSON.parse(fail.stdout).goalCheck.verdict, 'FAIL');
  assert.match(fail.stderr, /NG 守る debt\.total < 0: \d+/);
  const wrong = cli(['--goal', goal(['| debt.total | ≦ | 0 | 守る |'])]);
  assert.equal(wrong.status, 2);
  assert.equal(wrong.stdout, '');
  assert.match(wrong.stderr, /比べ方は = <= >= < > のどれか: ≦/);
  const noBase = cli(['--goal', goal(['| debt.total | <= | baseline | 守る |'])]);
  assert.equal(noBase.status, 2);
  assert.match(noBase.stderr, /基準のコミットを渡す/);
  assert.equal(cli(['--tests']).status, 2);
  assert.equal(cli(['--engine', 'mysql']).status, 2);
  assert.match(cli(['--tests', 'test/no-such.test.mjs']).stderr, /試験のファイルが無い/);
});

test('要約は、前処理が通っていない試験の結果に1行を足す（prepared は真偽値で goal_check に載らない）', () => {
  const metrics = staticMetrics(memory({'test/pg-matrix.json': JSON.stringify({pending: [], sqliteOnly: []})}));
  const sqlite = {target: 'sqlite', fileCount: 1, ...counts(1, 1, 0), exitCode: 0, failures: [], files: ['test/a.test.mjs']};
  const text = testRun => summary({commit: null, dirty: false, metrics: {...metrics, testRun}, baseline: null, goalCheck: null});
  const line = /^ {2}前処理（scripts\/prepare-test-assets\.mjs）が通っていない（testRun\.prepared が false）/m;
  assert.match(text({selection: 'files', prepared: false, sqlite}), line);
  assert.doesNotMatch(text({selection: 'files', prepared: true, sqlite}), line);
  assert.doesNotMatch(text(null), line);
});

// goals/** の変更で選ばれる（test/select-map.json）。/goal の1ターン目で終了コード2になる書き方の誤りを、PR の試験で止める
test('goals/ に置いた goal は書き方の誤りが無く、npm run metrics -- --goal を引数なしで流せる', () => {
  const problems = workingTree(APP_DIR).files('goals', /^goals\/[^/]+\.md$/).filter(path => path !== 'goals/README.md').flatMap(path => {
    const goal = parseGoal(readFileSync(join(APP_DIR, path), 'utf8'), path);
    if (goal.problems.length) return goal.problems;
    const missing = Array.isArray(goal.tests) ? goal.tests.filter(file => !/^test\/[^/]+\.test\.mjs$/.test(file) || !existsSync(join(APP_DIR, file))) : [];
    if (missing.length) return [`${path}: tests の試験のファイルが無い: ${missing.join('、')}`];
    try { resolveOptions({}, goal); return []; } catch (error) { return [error.message]; }
  });
  assert.deepEqual(problems, []);
});
