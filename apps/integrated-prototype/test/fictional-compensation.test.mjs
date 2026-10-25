// 個人の額の守り（行動指標の計画 段B #23・K2-12）を確かめる。期待値は要件 docs/requirements/revenue/kpi-scenario-forecast.md の FR-REV-KPI-014・016 と
// project-cashflow-forecast-actual.md の FR-REV-YOJITSU-006 から持ってくる。
// ・種（scripts/ の seed・demo の道具と demo-fixtures/ の生成スクリプト）・pg/local-seed.sql・移行の初期の行・fixture（test/fixtures/・fixtures/・
//   demo-fixtures/・public/demo-fixtures/）に、報酬・家賃補助の行と金額の列が無く、目標・計画の行は fictional: true の印がある行だけ
//   （フェーズ1 #23a・#23c の架空の行。段A の test/fixtures/scenario/ も同じ検査に入る。段A の A-4 の延長）。試験のソースは見ない（試験の額は
//   実行時に作る取り決めと PR の目で守る）。種を流した DB の目標・計画の行と報酬の表は seed-all-demo.test.mjs が見る
// ・目標・計画の持ち主でない管理者の、データ一覧（GET /api/admin/tables/:name）・一括出力・帳票と、ほかのすべての GET の応答に、目標の額とその月割り・
//   源泉別の目標・第1版の計画の額（目標（会社）の仮置き）と導いた額（通算・本人＋会社の和）が無い。データ一覧と一括出力には第2版の計画の額も無い
//   （表名で除く）。別の組織の管理者のほかのすべての GET の応答には、組織1の第2版の計画の額も無い
// ・予測の版のヘッダと活動記録の表は金額の列を持たない。見直しの提案の表（段B #14）と報酬の表（フェーズ1 #17）ができたら、検査を足すまで落ちる
// 値が実額かどうかはこの試験では見られない（架空の印と、実行時に作る不規則な桁の額で確かめるだけ）。実額と一致しないことは人が PR で見る。
// 達成率・届く確率などの比の値は額の文字列で探せないので、その読み手の試験（FR-REV-KPI-014）が持ち主の判定を確かめる。
// 試験の額はソースに書かず test/personal-amount-fixture.mjs の fictionalYen で実行時に作る。ON_TEST_DB=pg で DB を使う試験が PostgreSQL で流れる
import test from 'node:test';
import assert from 'node:assert/strict';
import {existsSync, readFileSync, readdirSync, statSync} from 'node:fs';
import {join, relative} from 'node:path';
import {fileURLToPath} from 'node:url';
import {unzipSync, strFromU8} from 'fflate';
import {openTestDb} from './test-db.mjs';
import {createApp} from '../src/app.mjs';
import {BULK_ENTITIES} from '../src/bulk/bulk-entities.mjs';
import {OWNER_ONLY_TABLES} from '../src/admin/data-browser-routes.mjs';
import {readTableSchema} from '../src/admin/er-routes.mjs';
import * as store from '../src/revenue/revenue-store.mjs';
import {normalizeTargetInput, periodStarts} from '../src/revenue/yojitsu/yojitsu-model.mjs';
import {fictionalYen, fictionalSeedAmounts, COMPENSATION_TABLE_NAME} from './personal-amount-fixture.mjs';

const APP = fileURLToPath(new URL('../', import.meta.url));
const ADMIN = 1; // 組織1の管理者（試作の行）。目標・計画の持ち主でない
const EDITOR = 2; // 組織1の編集担当（試作の行）。目標・計画の持ち主（本人）
const OUTSIDER = 4; // 組織2の管理者（試作の行）。組織1の目標・計画を読めない
const EMAIL = {[ADMIN]: 'admin@openingnight.invalid', [EDITOR]: 'editor@openingnight.invalid', [OUTSIDER]: 'outsider@other.invalid'};

// 報酬・家賃補助の鍵・列・文字（報酬の種類は月収・家賃補助・交通費。フェーズ1 #17 の「月の固定給」と、賃金・年俸・手当の言い方も）。
// 作り手への成功報酬（FR-REV-KPI-012）と会社 PL の支払報酬（6260。士業への報酬）は報酬の行でない。
// 交通費は経費の旅費交通費と見分けられないので入れない（報酬の表の行は COMPENSATION_TABLE_NAME の表名で見る）
const COMPENSATION_WORD = /(?<!成功|支払)報酬|給与|給料|固定給|賃金|年俸|月収|家賃補助|手当|人件費|compensation|salar|wage|payroll|remuneration|subsid|housing/i;
// 目標・計画の行の額・件数の鍵（フェーズ1 #23a の種と #23c の golden の書き方と、英語の名前）と、目標・計画の行を並べる配列の鍵
const TARGET_AMOUNT_KEY = /目標額|計画額|計画の額|目標の額|目標件数|target_?(amount|yen)|plan_?(amount|yen)/i;
const TARGET_ROWS_KEY = /^(目標|計画|plan_adoptions|targets?|plans|target_?versions|plan_?versions|plan_?adoptions|plan_?amounts)$/i;
// 行の見出しの鍵。見出しに 目標・計画 を含む行（golden の「目標（本人）」「計画の合計」の行など）も目標・計画の行とみなす
const ITEM_KEY = /^(項目|label|item)$/i;
// 本人だけの4表（フェーズ1 #11。目標の版・計画の版と子表・採用の記録）。src の OWNER_ONLY_TABLES が縮んでも気づけるように名前で持ち、
// 後から定数に足した表（報酬の表など）も同じに見る
const OWNER_ONLY = [...new Set(['yojitsu_target_versions', 'yojitsu_plan_versions', 'yojitsu_plan_amounts', 'plan_adoptions', ...OWNER_ONLY_TABLES])];
// 目標・計画の版を足す store の関数（種がこれを呼ぶと、印の無い目標・計画の行が入りうる）
const OWNER_ONLY_WRITERS = ['addTargetVersion', 'targetVersionStatements', 'addPlanVersion', 'planVersionStatements', 'adoptPlanVersion', 'planAdoptionStatements'];

const rel = (path) => relative(APP, path).replaceAll('\\', '/');
const walk = (dir) => (existsSync(dir) ? readdirSync(dir).flatMap((name) => {
  const path = join(dir, name);
  return statSync(path).isDirectory() ? walk(path) : [path];
}) : []);
const FIXTURE_DIRS = ['test/fixtures', 'fixtures', 'demo-fixtures', 'public/demo-fixtures'];

// JSON の fixture の検査。報酬・家賃補助の鍵は印があっても持てない。目標・計画の行は自分に fictional: true の印があり、文書の根にも印がある。
// 種の fictional の目標・計画の額（amounts）は、根でない印のある行の中にだけ出る
function jsonProblems(doc, file, amounts = new Set()) {
  const problems = [];
  const targetRows = [];
  const visit = (value, path, parentKey, marked) => {
    if (Array.isArray(value)) {
      value.forEach((item, i) => visit(item, `${path}[${i}]`, parentKey, marked));
      return;
    }
    if (value && typeof value === 'object') {
      const entries = Object.entries(value);
      const isTargetRow = TARGET_ROWS_KEY.test(parentKey ?? '')
        || entries.some(([key, item]) => TARGET_AMOUNT_KEY.test(key) && !Array.isArray(item))
        || entries.some(([key, item]) => ITEM_KEY.test(key) && typeof item === 'string' && /目標|計画/.test(item));
      if (isTargetRow) {
        targetRows.push(path);
        if (value.fictional !== true) problems.push(`${file} ${path}: 目標・計画の行に fictional: true の印が無い`);
        if (doc?.fictional !== true) problems.push(`${file}: 目標・計画の行を持つのに、文書の根に fictional: true の印が無い`);
      }
      const rowMarked = marked || (path !== '' && value.fictional === true);
      for (const [key, item] of entries) {
        if (COMPENSATION_WORD.test(key)) problems.push(`${file} ${path}.${key}: 報酬・家賃補助の鍵`);
        visit(item, `${path}.${key}`, key, rowMarked);
      }
      return;
    }
    if (typeof value === 'number' && amounts.has(value) && !marked) problems.push(`${file} ${path}: 架空の目標・計画の額 ${value} が印の無い行にある`);
  };
  visit(doc, '', null, false);
  return {problems, targetRows};
}
// 表の見出し・セルの文字の検査（CSV・Excel の XML）。目標・計画の行の印を持てない形なので、目標・計画の額の列も持てない
const textProblems = (texts, where) => texts.filter((text) => COMPENSATION_WORD.test(text) || TARGET_AMOUNT_KEY.test(text)).map((text) => `${where}: 「${text}」`);
const xmlTexts = (xml) => [...xml.matchAll(/<t(?:\s[^>]*)?>([^<]*)<\/t>/g)].map((m) => m[1]);

// SQL の文字列（'…'）の外にある -- と /* */ のコメントを外す
function withoutComments(sql) {
  let out = '';
  for (let i = 0; i < sql.length;) {
    if (sql[i] === "'") {
      let j = i + 1;
      while (j < sql.length && !(sql[j] === "'" && sql[j + 1] !== "'")) j += sql[j] === "'" ? 2 : 1;
      out += sql.slice(i, j + 1);
      i = j + 1;
    } else if (sql.startsWith('--', i)) {
      const end = sql.indexOf('\n', i);
      i = end < 0 ? sql.length : end;
    } else if (sql.startsWith('/*', i)) {
      const end = sql.indexOf('*/', i + 2);
      i = end < 0 ? sql.length : end + 2;
    } else out += sql[i++];
  }
  return out;
}
// INSERT の文ごとに、表・列・VALUES か（SELECT で写す文でないか）・文の中の文字列を返す
function insertStatements(sql) {
  const text = withoutComments(sql);
  return [...text.matchAll(/\bINSERT\s+(?:OR\s+\w+\s+)?INTO\s+(?:\w+\s*\.\s*)?"?(\w+)"?\s*(?:\(([^)]*)\))?\s*/gi)].map((m) => {
    const rest = text.slice(m.index + m[0].length);
    let end = 0;
    for (let quoted = false; end < rest.length && (quoted || rest[end] !== ';'); end += 1) if (rest[end] === "'") quoted = !quoted;
    const body = rest.slice(0, end);
    return {table: m[1], columns: (m[2] ?? '').split(',').map((c) => c.trim().replace(/^"|"$/g, '')).filter(Boolean),
      values: !/^(SELECT|WITH)\b/i.test(rest), strings: [...body.matchAll(/'((?:[^']|'')*)'/g)].map((s) => s[1])};
  });
}
function sqlProblems(sql, file) {
  const problems = [];
  for (const s of insertStatements(sql)) {
    // 本人だけの表と報酬の表に行を入れない（表を作り直す移行が SELECT で写す文は、種の行でないので除く）
    if (s.values && (OWNER_ONLY.includes(s.table) || COMPENSATION_TABLE_NAME.test(s.table))) problems.push(`${file}: ${s.table} に行を入れる`);
    for (const column of s.columns) if (COMPENSATION_WORD.test(column) || TARGET_AMOUNT_KEY.test(column)) problems.push(`${file}: ${s.table}.${column} は報酬・目標・計画の額の列`);
    for (const value of s.strings) if (COMPENSATION_WORD.test(value)) problems.push(`${file}: ${s.table} の行に「${value}」`);
  }
  return problems;
}
// 種の道具（JS・Python）の検査。本人だけの表を名前で書かず、目標・計画を足す store の関数を呼ばず、報酬の表の名前を SQL に書かない。
// フェーズ1 #23d の種（test/fixtures/yojitsu/seed.json の fictional の目標・計画の行を入れる）が入ったら、その道具だけをこの検査から名指しで外す
// （入れた行が fictional の行の額だけであることは seed-all-demo.test.mjs が種を流した DB で見る）
function seedProblems(source, file) {
  const problems = [];
  for (const table of OWNER_ONLY) if (new RegExp(`\\b${table}\\b`).test(source)) problems.push(`${file}: ${table} を名前で書く`);
  for (const writer of OWNER_ONLY_WRITERS) if (new RegExp(`\\b${writer}\\b`).test(source)) problems.push(`${file}: ${writer} を呼ぶ`);
  for (const m of source.matchAll(/\b(?:INTO|UPDATE|FROM|JOIN)\s+["`]?([A-Za-z_]\w*)/gi)) if (COMPENSATION_TABLE_NAME.test(m[1])) problems.push(`${file}: 報酬の表 ${m[1]} を書く`);
  return problems;
}
const seedScripts = () => [
  ...readdirSync(join(APP, 'scripts')).filter((name) => /\.(mjs|py)$/.test(name) && /^seed-|demo/.test(name)).map((name) => join(APP, 'scripts', name)),
  ...walk(join(APP, 'demo-fixtures')).filter((path) => /\.(mjs|py)$/.test(path)),
];

test('FR-REV-KPI-016 fixture（test/fixtures・fixtures・demo-fixtures・public/demo-fixtures）に報酬・家賃補助の鍵・列・文字が無く、目標・計画の行は fictional: true の印がある行だけで、文書の根も架空の印を持ち、架空の目標・計画の額は印のある行の中にだけ出る', () => {
  // 検査そのもの: 印の無い目標の行・印の無い文書・報酬と家賃補助の鍵・印の無い行に出た架空の額・目標の額の列を見つけ、成功報酬は報酬の行とみなさない
  const amounts = new Set([fictionalYen(901)]);
  assert.deepEqual(jsonProblems({fictional: true, 目標: [{目標ID: 'X', fictional: true}, {目標ID: 'Y'}]}, 'a.json').problems, ['a.json .目標[1]: 目標・計画の行に fictional: true の印が無い']);
  assert.deepEqual(jsonProblems({rows: [{targetYen: 1, fictional: true}]}, 'b.json').problems, ['b.json: 目標・計画の行を持つのに、文書の根に fictional: true の印が無い']);
  assert.deepEqual(jsonProblems({fictional: true, rows: [{label: '目標（本人）', value: 1}]}, 'c.json').problems, ['c.json .rows[0]: 目標・計画の行に fictional: true の印が無い']);
  assert.deepEqual(jsonProblems({fictional: true, rows: [{月収: 1, fictional: true}, {rentSubsidyYen: 1}, {成功報酬の率: 1}]}, 'd.json').problems,
    ['d.json .rows[0].月収: 報酬・家賃補助の鍵', 'd.json .rows[1].rentSubsidyYen: 報酬・家賃補助の鍵']);
  assert.deepEqual(jsonProblems({fictional: true, total: [...amounts][0], rows: [{fictional: true, value: [...amounts][0]}]}, 'e.json', amounts).problems,
    [`e.json .total: 架空の目標・計画の額 ${[...amounts][0]} が印の無い行にある`]);
  assert.deepEqual(textProblems(['作品', '家賃補助', '目標額（円）', '成功報酬', '支払報酬', '役員報酬', '固定給（月）'], 'f.csv'),
    ['f.csv: 「家賃補助」', 'f.csv: 「目標額（円）」', 'f.csv: 「役員報酬」', 'f.csv: 「固定給（月）」']);

  const {targets, plans} = fictionalSeedAmounts();
  assert.ok(targets.size > 0 && plans.size > 0, 'フェーズ1 #23a の種に fictional の目標・計画の行がある');
  const seedAmounts = new Set([...targets, ...plans]);
  const problems = [];
  const targetFiles = new Set();
  const seen = {json: 0, csv: 0, xml: 0, xlsx: 0};
  for (const path of FIXTURE_DIRS.flatMap((dir) => walk(join(APP, dir)))) {
    const file = rel(path);
    if (path.endsWith('.json')) {
      seen.json += 1;
      const found = jsonProblems(JSON.parse(readFileSync(path, 'utf8').replace(/^\uFEFF/, '')), file, seedAmounts);
      problems.push(...found.problems);
      if (found.targetRows.length) targetFiles.add(file);
    } else if (path.endsWith('.csv')) {
      seen.csv += 1;
      const header = readFileSync(path, 'utf8').replace(/^\uFEFF/, '').split(/\r?\n/)[0];
      problems.push(...textProblems(header.split(',').map((h) => h.replace(/^"|"$/g, '')), file));
    } else if (path.endsWith('.xml')) {
      seen.xml += 1;
      problems.push(...textProblems(xmlTexts(readFileSync(path, 'utf8')), file));
    } else if (path.endsWith('.xlsx')) {
      seen.xlsx += 1;
      for (const [name, bytes] of Object.entries(unzipSync(readFileSync(path)))) if (name.endsWith('.xml')) problems.push(...textProblems(xmlTexts(strFromU8(bytes)), `${file}:${name}`));
    }
  }
  assert.deepEqual(problems, []);
  // 検査が空振りしていない: JSON・CSV・Excel の XML を読み、フェーズ1 #23a の種と #23c の golden の目標・計画の行を見つけた
  assert.ok(seen.json > 0 && seen.csv > 0 && seen.xml > 0, JSON.stringify(seen));
  for (const file of ['test/fixtures/yojitsu/seed.json', 'test/fixtures/yojitsu/expected.json']) assert.ok(targetFiles.has(file), `${file} の目標・計画の行を見つけていない`);
});

test('FR-REV-KPI-016 pg/local-seed.sql と移行の SQL の INSERT は、目標の版・計画の版と子表・採用の記録・報酬の表に行を入れず、報酬・家賃補助・目標・計画の額の列と文字を持たない', () => {
  // 検査そのもの: 本人だけの表への VALUES・報酬の表・額の列・報酬の文字を見つけ、表を作り直す SELECT の写しとコメントの中の文字は見ない
  const sample = `-- 家賃補助はコメント\nINSERT INTO plan_adoptions(org_id) VALUES(1);\nINSERT INTO yojitsu_target_versions(id) SELECT id FROM old_targets;
    INSERT INTO monthly_salaries(a) VALUES(1);\nINSERT INTO x (target_amount_yen, note) VALUES (1, '架空の家賃補助') ON CONFLICT DO NOTHING;\n/* 報酬 */ INSERT INTO y(a) VALUES('成功報酬');`;
  assert.deepEqual(sqlProblems(sample, 's.sql'), ['s.sql: plan_adoptions に行を入れる', 's.sql: monthly_salaries に行を入れる',
    's.sql: x.target_amount_yen は報酬・目標・計画の額の列', 's.sql: x の行に「架空の家賃補助」']);

  const files = ['pg/local-seed.sql', ...readdirSync(join(APP, 'migrations')).filter((name) => /^\d{4}_.+\.sql$/.test(name)).sort().map((name) => `migrations/${name}`)];
  const problems = [];
  let inserts = 0;
  for (const file of files) {
    const sql = readFileSync(join(APP, file), 'utf8');
    inserts += insertStatements(sql).length;
    problems.push(...sqlProblems(sql, file));
  }
  assert.deepEqual(problems, []);
  assert.ok(insertStatements(readFileSync(join(APP, 'pg/local-seed.sql'), 'utf8')).length > 10 && inserts > 20, `INSERT の文を読めていない（${inserts}）`);
});

test('FR-REV-KPI-016 種（scripts/ の seed・demo の道具と demo-fixtures/ の生成スクリプト）は、目標の版・計画の版と子表・採用の記録・報酬の表を名前で書かず、目標・計画の版を足す store の関数を呼ばない', () => {
  // 調べる関数の名前が store に実在する（名前が変わったら検査を直す）
  for (const writer of OWNER_ONLY_WRITERS) assert.equal(typeof store[writer], 'function', `revenue-store.mjs に ${writer} が無い`);
  // 検査そのもの
  assert.deepEqual(seedProblems("await store.addTargetVersion(db, 1, row);\ndb.run('INSERT INTO compensation_rows(a) VALUES(1)');\ndb.all('SELECT * FROM plan_adoptions');\nimport x from './seed.mjs';", 'x.mjs'),
    ['x.mjs: plan_adoptions を名前で書く', 'x.mjs: addTargetVersion を呼ぶ', 'x.mjs: 報酬の表 compensation_rows を書く']);
  const scripts = seedScripts();
  assert.ok(scripts.some((path) => rel(path) === 'scripts/seed-all-demo.mjs') && scripts.some((path) => rel(path) === 'scripts/seed-plbs-demo.mjs'), '種の道具を読めていない');
  assert.deepEqual(scripts.flatMap((path) => seedProblems(readFileSync(path, 'utf8'), rel(path))), []);
});

// 目標・計画の持ち主（本人）を編集担当にして、目標の版・計画の版（第1版と第2版）・採用の記録を足し、本人だけの額を返す。
// strict はデータ一覧・一括出力に出ない額（第2版の計画の額を含む）、ownerOnly は本人以外のどの応答にも出ない額（第2版の計画の額は除く。
// 第2版を採用したあとの計画の額は本人以外にも返す。FR-REV-YOJITSU-006）
async function ownerRows(db) {
  const yen = (n) => fictionalYen(200 + n);
  await store.definePeriods(db, 1, periodStarts('2026-10-01').map((startsOn, i) => ({yearNo: i + 1, startsOn})), {createdBy: ADMIN});
  const period = new Map((await store.listPeriods(db, 1)).map((p) => [p.yearNo, p.id]));
  const target = async (overrides) => {
    const n = normalizeTargetInput({previousVersionNo: 0, kind: 'self', scope: 'all', unit: 'period_total', basisKind: 'amount', status: 'provisional',
      decidedOn: '2026-10-02', decidedBy: '架空の代表', basis: '架空の目標', ownerUserId: EDITOR, ...overrides});
    assert.equal(n.ok, true, JSON.stringify(n.errors));
    await store.addTargetVersion(db, 1, n.value, {createdBy: EDITOR});
  };
  const sources = {1: yen(1), 2: yen(2), 3: yen(3), 4: yen(4), 5: yen(5)};
  const targets = {self1: yen(6), self1Revised: yen(7), company1: yen(8), productionShare1: yen(9), company2: yen(10), monthly3: yen(11)};
  await target({periodId: period.get(1), amountYen: targets.self1, sources});
  await target({periodId: period.get(1), previousVersionNo: 1, amountYen: targets.self1Revised, decidedOn: '2026-11-04'}); // 改めた版
  await target({periodId: period.get(1), kind: 'company', amountYen: targets.company1});
  await target({periodId: period.get(1), scope: 'production_share', amountYen: targets.productionShare1}); // 制作の取り分
  await target({periodId: period.get(2), kind: 'company', amountYen: targets.company2});
  await target({periodId: period.get(2), basisKind: 'labor_cost_multiple', multiplierX100: 347}); // 人件費×倍率（報酬の行が無い間は額が null）
  await target({periodId: period.get(3), unit: 'monthly', amountYen: targets.monthly3});
  // 第1版の計画は目標（会社）の額を稼ぎ方に配った仮置き（FR-REV-YOJITSU-013）。不規則な重みで配り、端数は最後の稼ぎ方
  const EARNING = ['acquisition', 'consignment', 'own_investment', 'committee', 'contract_work'];
  const split = (total, seed) => {
    const weights = EARNING.map((_, i) => BigInt(yen(seed + i)));
    const sum = weights.reduce((a, b) => a + b, 0n);
    const parts = weights.slice(0, -1).map((w) => Number(BigInt(total) * w / sum));
    return [...parts, total - parts.reduce((a, b) => a + b, 0)];
  };
  const plan = (periodId, previousVersionNo, amounts, on) => store.addPlanVersion(db, 1, {periodId, previousVersionNo, ownerUserId: EDITOR, status: 'provisional',
    basis: '架空の計画', createdOn: on, adoptedOn: on, amounts: EARNING.map((earningType, i) => ({earningType, amountYen: amounts[i]}))}, {createdBy: EDITOR});
  const first1 = split(targets.company1, 20);
  const first2 = split(targets.company2, 30);
  const second1 = EARNING.map((_, i) => yen(40 + i));
  await plan(period.get(1), 0, first1, '2026-10-02');
  await plan(period.get(1), 1, second1, '2026-11-16'); // 1年目は第2版を採用
  await plan(period.get(2), 0, first2, '2026-10-02'); // 2年目は第1版を指したまま
  assert.equal(first1.reduce((a, b) => a + b, 0), targets.company1);
  // 額の月割り（年÷12 の切り捨て・四捨五入と、端数を持つ最後の月）も同じ値として探す
  const withMonths = (label, value) => [{label, value}, ...[...new Set([Math.trunc(value / 12), Math.round(value / 12), value - 11 * Math.trunc(value / 12)])]
    .map((month) => ({label: `${label} の月割り`, value: month}))];
  const ownerOnly = [
    ...Object.entries(targets).flatMap(([key, value]) => withMonths(`目標 ${key}`, value)),
    {label: '目標 monthly3 の12か月', value: targets.monthly3 * 12}, // 単位が毎月の目標は、年の値（×12）も探す
    ...Object.entries(sources).flatMap(([n, value]) => withMonths(`源泉${n}の目標`, value)),
    ...first1.flatMap((value, i) => withMonths(`1年目の第1版の ${EARNING[i]}`, value)),
    ...first2.flatMap((value, i) => withMonths(`2年目の第1版の ${EARNING[i]}`, value)),
    // 導いた額: 有効な目標（期間×種類×範囲ごとの最新の版）の期間の合計（通算5年）と、本人＋会社の和。2年目の本人は人件費×倍率で、
    // 報酬の行が無い間は額が null なので和に入れない。源泉別の目標の合計も
    ...derived(targets, sources).flatMap(({label, value}) => withMonths(label, value)),
  ];
  const second = [...second1.flatMap((value, i) => withMonths(`1年目の第2版の ${EARNING[i]}`, value)),
    ...withMonths('1年目の第2版の合計', second1.reduce((a, b) => a + b, 0))];
  // 架空の額は安全な整数で、ほかの数と取り違えない桁を持ち、互いに違う
  const all = [...ownerOnly, ...second];
  assert.ok(all.every(({value}) => Number.isSafeInteger(value) && value >= 100000), JSON.stringify(all));
  assert.equal(new Set(all.map(({value}) => value)).size, all.length);
  return {ownerOnly, strict: all, targets};
}

// 有効な目標から導いた額（期間の合計〈通算5年〉と本人＋会社の和）
function derived(targets, sources) {
  const selfTotal = targets.self1Revised + targets.monthly3 * 12;
  const companyTotal = targets.company1 + targets.company2;
  return [
    {label: '目標（本人）の通算', value: selfTotal},
    {label: '目標（会社）の通算', value: companyTotal},
    {label: '目標（本人＋会社）の1年目', value: targets.self1Revised + targets.company1},
    {label: '目標（本人＋会社）の通算', value: selfTotal + companyTotal},
    {label: '源泉別の目標の合計', value: Object.values(sources).reduce((a, b) => a + b, 0)},
  ];
}

async function appWithLogin(db) {
  const app = createApp({db, mode: 'local'});
  const login = async (email) => {
    const response = await app.request('/api/local/login', {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify({email})});
    assert.equal(response.status, 200);
    return response.headers.get('set-cookie').split(';')[0];
  };
  // 応答の本文を文字で返す。Excel（zip）は中の XML をつなげて読む
  const get = async (cookie, url) => {
    const response = await app.request(url, {headers: {cookie}});
    const bytes = new Uint8Array(await response.arrayBuffer());
    const text = bytes[0] === 0x50 && bytes[1] === 0x4b ? Object.values(unzipSync(bytes)).map((entry) => strFromU8(entry)).join('\n') : new TextDecoder().decode(bytes);
    return {status: response.status, text};
  };
  return {app, login, get};
}
// 額をそのままの数字と3桁区切りで探す関数を作る（前後が数字なら別の数。3桁区切りは前後が区切りの続きでも別の数）。見つけた額の見出しを返す
function leakFinder(secrets) {
  const label = new Map(secrets.flatMap(({label: name, value}) => [[String(value), `${name}（${value}）`], [value.toLocaleString('en-US'), `${name}（${value}）`]]));
  const alternatives = (format) => secrets.map(({value}) => format(value)).join('|');
  const plain = new RegExp(`(?<!\\d)(?:${alternatives(String)})(?!\\d)`, 'g');
  const grouped = new RegExp(`(?<![\\d,])(?:${alternatives((value) => value.toLocaleString('en-US'))})(?!\\d|,\\d)`, 'g');
  return (text) => [...new Set([...text.matchAll(plain), ...text.matchAll(grouped)].map((m) => label.get(m[0])))];
}

test('FR-REV-KPI-016 FR-REV-YOJITSU-006 目標・計画の持ち主でない管理者のデータ一覧（GET /api/admin/tables/:name）と一括出力の応答に、目標の額と月割り・源泉別の目標・第1版と第2版の計画の額が無い', async (t) => {
  const db = await openTestDb({t});
  const {strict} = await ownerRows(db);
  const leaks = leakFinder(strict);
  const {login, get} = await appWithLogin(db);
  const admin = await login(EMAIL[ADMIN]);
  // データ一覧: 表の一覧と、出る表ごとの行（表の定義は列の名前と説明だけで行の値を持たない）。受け口は読むたびに全部の表の定義を読み直すので、
  // 行のある表（どの組織の行でも）だけを読む（行の無い表の応答は列の名前だけ）
  const list = await get(admin, '/api/admin/tables');
  assert.equal(list.status, 200);
  const names = JSON.parse(list.text).tables.map((table) => table.name);
  assert.ok(names.length > 100 && names.includes('yojitsu_periods') && names.includes('audit_log'), `データ一覧の表が少ない（${names.length}）`);
  const withRows = [];
  for (const name of names) if (Number((await db.get(`SELECT COUNT(*) AS n FROM "${name.replaceAll('"', '""')}"`)).n) > 0) withRows.push(name);
  // 目標・計画の期間と、目標・計画を足した記録（監査の記録）の表を読んでいる
  assert.ok(withRows.includes('yojitsu_periods') && withRows.includes('audit_log') && withRows.includes('projects'), JSON.stringify(withRows));
  const found = [];
  for (const name of withRows) {
    const path = `/api/admin/tables/${name}`;
    const out = await get(admin, path);
    assert.equal(out.status, 200, path);
    found.push(...leaks(out.text).map((leak) => `${path}: ${leak}`));
  }
  // 本人だけの4表は名前で見る（額を持たない計画の版のヘッダと採用の記録も）: DB にあり、データ一覧の表の一覧に無く、表ごとの受け口は 404 で、
  // 一括出力の対象の表でもない
  const schema = await readTableSchema(db);
  const bulkTables = Object.values(BULK_ENTITIES).map((entity) => entity.table);
  for (const table of OWNER_ONLY) {
    assert.ok(schema.tables.some((x) => x.name === table), `${table} が DB に無い`);
    assert.ok(!names.includes(table), `${table} がデータ一覧の表の一覧に出る`);
    assert.equal((await get(admin, `/api/admin/tables/${table}`)).status, 404, `${table} がデータ一覧に出る`);
    assert.ok(!bulkTables.includes(table), `${table} が一括出力の対象`);
  }
  // 一括出力: 対象の一覧・種類ごとの列と行（Excel はこの行から作る）
  const entities = await get(admin, '/api/bulk/entities');
  assert.equal(entities.status, 200);
  const kinds = JSON.parse(entities.text).entities.map((e) => e.entity);
  assert.deepEqual([...kinds].sort(), Object.keys(BULK_ENTITIES).sort());
  for (const path of ['/api/bulk/entities', '/api/bulk/batches', ...kinds.flatMap((kind) => [`/api/bulk/${kind}/spec`, `/api/bulk/${kind}/rows`])]) {
    const out = await get(admin, path);
    assert.equal(out.status, 200, path);
    found.push(...leaks(out.text).map((leak) => `${path}: ${leak}`));
  }
  assert.deepEqual(found, []);
  // 報酬の表（フェーズ1 #17。報酬の種類は月収・家賃補助・交通費）はまだ無い。表を足したら、この試験と下の GET の試験に報酬の行を fictionalYen で足し、
  // その額も strict・ownerOnly に入れる（足すまでここで落ちる。表名をデータ一覧・一括出力から除くことは self-multiplier.test.mjs も見る）
  assert.deepEqual(schema.tables.map((table) => table.name).filter((name) => COMPENSATION_TABLE_NAME.test(name)), [],
    '報酬の表ができた。この試験に報酬の行（月収・家賃補助・交通費）を足して、データ一覧・一括出力・帳票の応答に出ないことを確かめる');
});

// 帳票センター（src/reports/report-catalog.mjs）の項目が読む受け口のうち、条件を渡せば試作の行だけの DB でも 200 を返すもの。
// これらが 200 で読めたうえで額が無いことを見る（受け口の条件が変わって 400 になったら、下の QUERIES を直す）
const REPORT_ROUTES = ['/api/report-center', '/api/receipt-sheet', '/api/reports/annual-sales', '/api/reports/annual-sales/lines', '/api/reports/annual-dashboard',
  '/api/reports/partner-balance', '/api/reports/royalty-statement', '/api/reports/royalty-statement/holders', '/api/reports/mg-sales/months', '/api/reports/work-pnl',
  '/api/reports/pl-bs', '/api/reports/committee-monthly/works', '/api/royalty/ledger', '/api/royalty/statements', '/api/rights-reports/mg-portfolio', '/api/progress/matrix',
  '/api/billing/receivables', '/api/mg/ledger', '/api/sales-sheet', '/api/analytics/income', '/api/distribution-master'];
// 400（条件の誤り）を返した受け口は、1年目（2026-10〜2027-09）の条件を足して読み直す。基準の月と基準日で形の違う受け口がある
const QUERIES = ['', '?from=2026-10&to=2027-09&asOf=2027-09&start=2026-10&month=2026-10&workId=1&projectId=1',
  '?from=2026-10&to=2027-09&asOf=2027-09-30&start=2026-10&month=2026-10&workId=1&projectId=1'];

// 200 を返す受け口の数の下限（2026-10-11 の実測は GET の受け口 206 本のうち、組織1の管理者 151・組織2の管理者 118。残りは条件不足の 400・
// 道の引数 1 の行が無い 404・権限の 403 など）。受け口が条件不足や権限で読めなくなって検査が空振りしたら、ここで気づく
const MIN_OK_ROUTES = {admin: 150, outsider: 115};
// 巡回から名指しで外す受け口と理由。ほかの受け口が 500 を返したら落とす
const CRAWL_EXCLUDED = {
  '/api/downloads/:kind': "取込のひな形の CSV で、固定の架空の見本の値だけを返し目標・計画を読まない。workId の無い読みは integer('') が投げて 500 になり、"
    + 'スタックトレースを標準エラーに出す（src/app.mjs の受け口の不具合で、この試験の外）',
};

// GET の受け口をすべて読み、応答の本文から額を探す。道の引数は、汎用の一覧（/api/:resource）はデータ一覧の表の名前、一括出力の種類は対象の一覧、
// ほかは 1（組織1の行の ID。別の組織の利用者には組織の境界を越える読み）。データ一覧の表ごとの行は上の試験が全部の表で見るので、ここでは
// 監査の記録の表だけを読む（表ごとに表の定義を読み直すので、全部の表を2回読まない）。400 なら1年目の条件を足して読み直す。
// 返り値: 見つけた額（found）、200 を返した URL（okUrls）と受け口（okRoutes）、500 以上を返した読み（errors）、読んだ回数（requests）
async function crawl(app, get, cookie, leaks) {
  const tables = JSON.parse((await get(cookie, '/api/admin/tables')).text).tables.map((table) => table.name);
  const kinds = JSON.parse((await get(cookie, '/api/bulk/entities')).text).entities.map((e) => e.entity);
  const routes = [...new Set(app.routes.filter((route) => route.method === 'GET' && route.path.startsWith('/api/')).map((route) => route.path))];
  const targets = routes.filter((route) => !Object.hasOwn(CRAWL_EXCLUDED, route)).flatMap((route) => {
    const fill = route.includes(':resource') ? tables : route.includes(':name') ? ['audit_log'] : route.includes(':entity') ? kinds : ['1'];
    return fill.map((value) => ({route, url: route.replace(/:\w+(\{[^}]*\})?/g, value)}));
  });
  const result = {routes, urls: targets.length, found: [], okUrls: new Set(), okRoutes: new Set(), errors: [], requests: 0};
  for (const {route, url} of targets) {
    for (const query of QUERIES) {
      const out = await get(cookie, url + query);
      result.requests += 1;
      result.found.push(...leaks(out.text).map((leak) => `${url}${query}: ${leak}`));
      if (out.status >= 500) result.errors.push(`${url}${query}: ${out.status}`);
      if (out.status === 200) {
        result.okUrls.add(url);
        result.okRoutes.add(route);
      }
      if (out.status !== 400) break;
    }
  }
  return result;
}

test('FR-REV-KPI-014 FR-REV-KPI-016 FR-REV-YOJITSU-006 目標・計画の持ち主でない管理者と別の組織の管理者の帳票と、ほかのすべての GET の応答に、目標の額と月割り・源泉別の目標・第1版の計画の額（目標（会社）の仮置き）と導いた額（通算・本人＋会社の和）が無く、持ち主の本人の倍率の応答には目標の額がある', async (t) => {
  const db = await openTestDb({t});
  const {ownerOnly, strict, targets} = await ownerRows(db);
  const {app, login, get} = await appWithLogin(db);
  // 探し方が働く: 持ち主（本人）が読む本人の倍率の応答には、有効な目標の額がある
  const own = await get(await login(EMAIL[EDITOR]), '/api/revenue/metrics/self-multiplier');
  assert.equal(own.status, 200);
  assert.deepEqual(leakFinder(ownerOnly.filter(({label}) => /^目標 (self1Revised|company1|company2)$/.test(label)))(own.text).length, 3, own.text);
  // 外す受け口は実在する（名前が変わったら一覧を直す）
  const routes = app.routes.filter((route) => route.method === 'GET').map((route) => route.path);
  for (const route of Object.keys(CRAWL_EXCLUDED)) assert.ok(routes.includes(route), `${route} が無い（CRAWL_EXCLUDED を直す）`);

  // 組織1の管理者（持ち主でない）
  const byAdmin = await crawl(app, get, await login(EMAIL[ADMIN]), leakFinder(ownerOnly));
  assert.ok(byAdmin.routes.length > 150 && byAdmin.routes.includes('/api/revenue/metrics/self-multiplier'), `GET の受け口が少ない（${byAdmin.routes.length}）`);
  assert.deepEqual(byAdmin.found, []);
  assert.deepEqual(byAdmin.errors, []);
  // 空振りしていない: 帳票の受け口が 200 で読め、200 を返した受け口が下限以上ある（受け口が条件不足や権限で読めなくなったら、ここで気づく）。
  // 本人の倍率は持ち主でない管理者に 403（self-multiplier.test.mjs）なので 200 にならない
  assert.deepEqual(REPORT_ROUTES.filter((route) => !byAdmin.okUrls.has(route)), []);
  assert.ok(!byAdmin.okUrls.has('/api/revenue/metrics/self-multiplier'));
  assert.ok(byAdmin.okRoutes.size >= MIN_OK_ROUTES.admin, `200 を返した受け口が少ない（${byAdmin.okRoutes.size} / ${byAdmin.routes.length}）`);
  assert.ok(byAdmin.requests > byAdmin.urls, `条件を足して読み直していない（${byAdmin.requests}）`);

  // 別の組織（組織2）の管理者: 組織1の目標・計画の額は、第2版の計画の額も含めて出ない（道の引数 1 は組織1の行の ID）
  const byOutsider = await crawl(app, get, await login(EMAIL[OUTSIDER]), leakFinder(strict));
  assert.deepEqual(byOutsider.found, []);
  assert.deepEqual(byOutsider.errors, []);
  assert.ok(byOutsider.okRoutes.size >= MIN_OK_ROUTES.outsider, `別の組織の管理者が 200 で読めた受け口が少ない（${byOutsider.okRoutes.size} / ${byOutsider.routes.length}）`);
  assert.ok(Object.values(targets).every((value) => ownerOnly.some((secret) => secret.value === value)));
});

// 金額の列の名前
const MONEY_COLUMN = /yen|amount|price|cost|fee|salar|compens|wage/i;
// 見直しの提案の表（段B #14。提案の行は参照の ID と率だけを持つ）を見つける表名。いまある別の機能の表は理由つきで除く
const PROPOSAL_TABLE_NAME = /proposal|suggest|recommend|(^|_)reviews?(_|$)/i;
const UNRELATED_PROPOSAL_TABLES = {
  change_proposals: '指標の項目の追加の申請',
  work_proposal_profiles: '営業の作品の提案資料',
  broadcast_proposal_drafts: '放送ウィンドウの提案から作った放送枠の下書き',
  broadcast_proposal_draft_deletions: '放送枠の下書きの削除の記録',
  workflow_script_reviews: '台本の確認の記録',
  source_sampling_reviews: 'フォルダからの受け取りの抜き取りの記録（移行 0023。FR-REV-FOLDER-013）。見直しの提案ではない',
  sales_proposals: '営業管理の取引先への1回の提案（移行 0049）。見直しの提案ではない',
  sales_proposal_windows: '営業の提案で結んだウィンドウ（移行 0049）',
  sales_proposal_reviews: '営業の提案の結果と自己評価（移行 0049）。見直しの提案ではない',
  sales_proposal_review_factors: '営業の提案の効いた要因（移行 0049）',
};

test('FR-REV-KPI-016 予測の版のヘッダと活動記録とその取消の表（フェーズ1 #13）は、参照の ID・区分・日付・文だけを持ち金額の列を持たず、見直しの提案の表（段B #14）ができたら提案の表の検査を足すまで落ちる', async (t) => {
  const db = await openTestDb({t});
  const schema = await readTableSchema(db);
  // 予測の行（yojitsu_forecast_lines.amount_yen）は会社の予測の額（試算の写し・手入力の予測）で本人だけの値でないので、この検査の対象外（FR-REV-KPI-016）
  for (const name of ['yojitsu_forecast_versions', 'yojitsu_activity_records', 'yojitsu_activity_cancellations']) {
    const table = schema.tables.find((x) => x.name === name);
    assert.ok(table, `${name} が無い`);
    assert.ok(table.columns.length > 3, name);
    assert.deepEqual(table.columns.map((column) => column.name).filter((column) => MONEY_COLUMN.test(column)), [], name);
  }
  // 検査そのもの: 提案の表のありそうな名前を見つけ、取込の下見の表（*_previews）は見つけない
  assert.deepEqual(['yojitsu_review_proposals', 'kpi_review_suggestions', 'review_items', 'broadcast_import_previews', 'yojitsu_activity_records']
    .filter((name) => PROPOSAL_TABLE_NAME.test(name)), ['yojitsu_review_proposals', 'kpi_review_suggestions', 'review_items']);
  // 見直しの提案の表はまだ無い（段B #14 が足す）。表を足したら、#14 がこの試験に、提案の表が金額の列を持たないことと、データ一覧
  // （HIDDEN_TABLES。表の一覧に無く GET /api/admin/tables/<表名> が 404）・一括出力・帳票の対象外であること（本人だけの4表の検査と同じ形）を足す
  const names = schema.tables.map((table) => table.name);
  for (const name of Object.keys(UNRELATED_PROPOSAL_TABLES)) assert.ok(names.includes(name), `${name} が無い（UNRELATED_PROPOSAL_TABLES を直す）`);
  assert.deepEqual(names.filter((name) => PROPOSAL_TABLE_NAME.test(name) && !Object.hasOwn(UNRELATED_PROPOSAL_TABLES, name)), [],
    '見直しの提案の表（段B #14）ができた。提案の表が金額の列を持たず、データ一覧・一括出力・帳票の対象外であることを確かめる検査を足す（別の機能の表なら UNRELATED_PROPOSAL_TABLES に理由つきで足す）');
});
