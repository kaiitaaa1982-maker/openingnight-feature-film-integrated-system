// 架空の種（test/fixtures/yojitsu/seed.json）の案件・作品・区分・予測・活動記録を移行 0012・0015 の表に入れ、store の読み取り
// （src/revenue/revenue-store.mjs の readForecasts・readActivityTallies・readActivityRecords）と純関数（forecast-model・activity-model）で読んだ値が、
// golden（expected.json。フェーズ1 #23c。種を build_yojitsu.py に流した値）の月別の予測の行・行動の実績件数・携わった案件数と一致することを確かめる
// （フェーズ1の仕様書 #13 の受け入れ基準）。月別の予測・件数は整数なので、golden の値とそのまま比べる。ON_TEST_DB=pg で同じ試験が PostgreSQL で流れる。
// 活動記録の案件は必須（FR-REV-YOJITSU-035・017）で、種の活動記録は全部の行が案件を持つ（作品の無い段の買付候補の面談・受託の引き合いは、
// 企画メモの段階の案件 YJ-P31・P32 の行。要件の要確認18）。種の全部の行を入れ、golden の件数と足し引きなしで比べる
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {openTestDb} from './test-db.mjs';
import * as planning from '../src/planning/planning-store.mjs';
import * as store from '../src/revenue/revenue-store.mjs';
import {normalizeProjectInput} from '../src/planning/project/project-model.mjs';
import {forecastCashflowByMonth, normalizeForecastVersionInput} from '../src/revenue/yojitsu/forecast-model.mjs';
import {countActivitySteps, engagedProjectCounts, normalizeActivityInput} from '../src/revenue/yojitsu/activity-model.mjs';

const read = (name) => JSON.parse(readFileSync(new URL(`./fixtures/yojitsu/${name}`, import.meta.url), 'utf8').replace(/\r\n/g, '\n'));
const seed = read('seed.json');
const golden = read('expected.json');
const OWNER = 'demo-admin@openingnight.invalid'; // 種の持ち主（行動指標の計画 A-4 の利用者。架空のアドレス）
const EDITOR = 2; // 組織1の編集担当（試作の行）。活動記録を記録していない人

// 種の語 → 表の語
const PROJECT_TYPE = {製作: 'production', 買付: 'acquisition', 受託配給: 'agency', 受託制作: 'contract_production'};
const SCENARIO = {even: 'even', good: 'good', MAX: 'max', 単一: 'single'};
const STATUS = {確認済み: 'confirmed', 監督申告: 'director_reported', 報道値: 'press_reported', 仮置き: 'provisional'};
const RESULT = {進んだ: 'advanced', 保留: 'on_hold', 失注: 'lost'};
const STEP = {面談: 'meeting', 提案: 'proposal', 契約: 'contract'};
// 区分マスタ（入金4・出金5。K-9）のコードは架空の組織の種の値（移行では行を入れない）
const CATEGORY_CODE = {流通売上: 'distribution_sales', 販売委託の売上: 'consignment_sales', 受託収益: 'contract_revenue', クラウドファンディングの支援金: 'crowdfunding_support',
  出資: 'investment', 買付: 'acquisition_payment', 制作の実費: 'production_cost', '作り手・権利元への分配': 'creator_share', クラウドファンディングの費用: 'crowdfunding_cost'};
const K17_SOURCE = '施策の既定の予測行（計画の K-17 の形）';
const ym = (iso) => iso.slice(0, 7);
// 0.8 のような小数の率を、文字のまま bp に読む（浮動小数を掛けない）
const ratioToBps = (ratio) => {
  const [whole, fraction = ''] = String(ratio).split('.');
  assert.ok(/^\d+$/.test(whole) && /^\d{0,4}$/.test(fraction), `率 ${ratio} は bp で表せない`);
  return Number(whole) * 10000 + Number(fraction.padEnd(4, '0'));
};

async function load(db) {
  const owner = Number((await db.get("INSERT INTO users(email,display_name) VALUES(?, '架空デモ管理者') RETURNING id", [OWNER])).id);
  await db.run("INSERT INTO memberships(org_id,user_id,role) VALUES(1,?,'admin')", [owner]);
  const by = {createdBy: owner};
  // 区分マスタ
  const categories = [];
  for (const [i, k] of seed.vocabulary.kubun.entries()) {
    const direction = k.direction === '入金' ? 'in' : 'out';
    const id = await planning.addCashflowCategory(db, 1, {code: CATEGORY_CODE[k.name], label: k.name, direction, countsAsRevenue: k.sales_source === 'はい' ? 1 : 0, sortOrder: i + 1});
    categories.push({id, label: k.name, direction});
  }
  const categoryId = new Map(categories.map((c) => [c.label, c.id]));
  // 案件（型・稼ぎ方・段階）。段階に入った日は始めた日
  const earningTypes = await planning.listEarningTypes(db);
  const stages = await planning.listProjectStages(db);
  const earningCode = new Map(earningTypes.map((e) => [e.label, e.code]));
  const stageCode = new Map(stages.map((s) => [s.label, s.code]));
  const projectId = new Map();
  for (const p of seed.案件) {
    const n = normalizeProjectInput({code: p.案件コード, title: p.案件名, projectType: PROJECT_TYPE[p.project_type], earningType: earningCode.get(p.稼ぎ方),
      stage: {code: stageCode.get(p.段階), enteredOn: p.始めた日, reason: p.段階 === '見送り' ? '架空の見送りの理由' : null}}, {earningTypes, stages});
    assert.equal(n.ok, true, `${p.案件コード}: ${JSON.stringify(n.errors)}`);
    projectId.set(p.案件コード, await planning.createProject(db, 1, n.value, by));
  }
  // 作品（試作の古い形の表。案件の作品）
  const workId = new Map();
  for (const w of seed.works) {
    workId.set(w.work_code, Number((await db.get('INSERT INTO works(org_id,project_id,code,title) VALUES(1,?,?,?) RETURNING id', [projectId.get(w.project_code), w.work_code, w.title])).id));
  }
  // 予測: 案件ごとに、種の版（作った日の順）を版の番号 1, 2 … で足す。種の「予測に使う」は版から導くので、行の印は全部「使う」で入れる
  const byProject = new Map();
  for (const f of seed.予測) {
    if (!byProject.has(f.案件コード)) byProject.set(f.案件コード, new Map());
    const versions = byProject.get(f.案件コード);
    const key = `${f.作った日}|${f.版}`;
    if (!versions.has(key)) versions.set(key, []);
    versions.get(key).push(f);
  }
  for (const [code, versions] of byProject) {
    const ordered = [...versions].sort(([a], [b]) => (a < b ? -1 : 1));
    for (const [i, [, rows]] of ordered.entries()) {
      const sources = new Set(rows.map((f) => f.出所));
      assert.equal(sources.size, 1, `${code} の版の出所が1つでない`);
      const n = normalizeForecastVersionInput({projectId: projectId.get(code), previousVersionNo: i, label: rows[0].版,
        sourceKind: rows[0].出所 === K17_SOURCE ? 'initiative' : 'manual', source: rows[0].出所, createdOn: rows[0].作った日,
        lines: rows.map((f) => ({scenario: SCENARIO[f.シナリオ], month: f.月, categoryId: categoryId.get(f.区分), item: f.項目, counterparty: f.相手,
          amountYen: f['金額（円・税別）'], status: STATUS[f.状態]}))}, {categories});
      assert.equal(n.ok, true, `${code}: ${JSON.stringify(n.errors.slice(0, 3))}`);
      await store.addForecastVersion(db, 1, n.value, by);
    }
  }
  // 行動のステップ: 細目の段（種の vocabulary の段）は親の step を持つ行として足す（行動指標の計画 #10 が種で足す形）。段の名前がステップと同じなら親そのもの
  const stepOf = new Map();
  let order = 100;
  for (const s of seed.vocabulary.activity_stages) {
    const key = `${s.stage}|${s.step}`;
    if (stepOf.has(key)) continue;
    if (s.stage === s.step) { stepOf.set(key, STEP[s.step]); continue; }
    order += 1;
    const code = `${STEP[s.step]}_${order}`;
    await planning.addActionStep(db, {code, label: s.stage, parentCode: STEP[s.step], sortOrder: order});
    stepOf.set(key, code);
  }
  const steps = await planning.listActionSteps(db);
  // 活動記録: 種の全部の行（案件は必須）
  for (const a of seed.活動記録) {
    assert.ok(projectId.has(a.案件コード), `活動記録の案件 ${a.案件コード} が種に無い`);
    const step = a.ステップ === 'その他' ? null : stepOf.get(`${a.stage}|${a.ステップ}`);
    assert.notEqual(step, undefined, `${a.stage}|${a.ステップ}`);
    const n = normalizeActivityInput({projectId: projectId.get(a.案件コード), occurredOn: a.日付, earningType: a.稼ぎ方 === null ? null : earningCode.get(a.稼ぎ方), step,
      counterparty: a.相手, summary: a.したこと, deliverable: a.成果物, nextAction: a.次の一手, nextDueOn: a.期日, result: RESULT[a.result],
      workId: a.work_code === null ? null : workId.get(a.work_code)}, {steps, earningTypes});
    assert.equal(n.ok, true, JSON.stringify(n.errors));
    await store.addActivityRecord(db, 1, n.value, by);
  }
  const periods = seed.設定.期間.map((p, i) => ({yearNo: i + 1, startsOn: p.始め, name: p.期間, ends: p.終わり}));
  return {owner, categories, categoryId, projectId, workId, steps, periods, earningCode};
}

// golden の月（YYYY-MM の61か月）ごとの値を、期間の合計とあわせて比べる
function assertMonthlyRow(key, valueOf, periods) {
  const row = golden.月別.行.find((r) => r.鍵 === key) ?? golden.予実.行.find((r) => r.鍵 === key);
  assert.ok(row, `${key} が golden に無い`);
  golden.月.forEach((month, i) => assert.equal(valueOf(month), row.月[i], `${key} ${month}`));
  for (const p of periods) {
    const months = golden.月.filter((m) => m >= ym(p.startsOn) && m <= ym(p.ends));
    assert.equal(months.reduce((sum, m) => sum + valueOf(m), 0), row.期間[p.name], `${key} ${p.name}`);
  }
}

test('FR-REV-YOJITSU-023 架空の種の予測の行を版で入れて読むと、全部の行が同じ値で残り、前の版の行は種の「予測に使う＝いいえ」と同じに読める', async (t) => {
  const db = await openTestDb({t});
  const {projectId, categoryId} = await load(db);
  const versions = await store.readForecasts(db, 1, [...projectId.values()], {history: true});
  const codeOf = new Map([...projectId].map(([code, id]) => [id, code]));
  const label = new Map([...categoryId].map(([name, id]) => [id, name]));
  const scenarioLabel = Object.fromEntries(Object.entries(SCENARIO).map(([k, v]) => [v, k]));
  const statusLabel = Object.fromEntries(Object.entries(STATUS).map(([k, v]) => [v, k]));
  const readBack = versions.flatMap((v) => v.lines.map((l) => ({案件コード: codeOf.get(v.projectId), 版: v.label, 作った日: v.createdOn, シナリオ: scenarioLabel[l.scenario], 月: l.month,
    区分: label.get(l.categoryId), 項目: l.item, 相手: l.counterparty, '金額（円・税別）': l.amountYen, 状態: statusLabel[l.status], 出所: v.source, 予測に使う: l.used ? 'はい' : 'いいえ'})));
  const key = (r) => [r.案件コード, r.作った日, r.版].join('|');
  const expected = [...seed.予測].map(({予測ID, ...rest}) => rest);
  // 案件ごと・版ごとに、種の行の順のまま読める
  assert.equal(readBack.length, expected.length);
  const group = (rows) => {
    const m = new Map();
    for (const r of rows) m.set(key(r), [...(m.get(key(r)) ?? []), r]);
    return m;
  };
  const got = group(readBack);
  for (const [k, rows] of group(expected)) assert.deepEqual(got.get(k), rows, k);
  // 案件ごとの最新の版だけが有効（種の 第1版 と 第2版 を持つ案件は 第2版）
  assert.deepEqual(versions.filter((v) => !v.effective).map((v) => [codeOf.get(v.projectId), v.versionNo, v.label]),
    [['YJ-P01', 1, '架空の試算 第1版'], ['YJ-P05', 1, '架空の試算 第1版']]);
});

test('FR-REV-YOJITSU-023 FR-REV-YOJITSU-029 有効な予測の区分×月の収支（採用するシナリオ good と単一）が、golden の月別の予測の行と期間の合計に一致する', async (t) => {
  const db = await openTestDb({t});
  const {projectId, categories, periods} = await load(db);
  const versions = await store.readForecasts(db, 1, [...projectId.values()]);
  const projects = await planning.readProjectClassifications(db, 1, [...projectId.values()]);
  const probability = new Map(projects.map((p) => [Number(p.id), p.probability_bps === null ? null : Number(p.probability_bps)]));
  const stage = new Map(projects.map((p) => [Number(p.id), p.stage_code]));
  const landing = ratioToBps(golden.設定.着地確度); // 0.8 → 8000 bp
  assert.equal(golden.設定.採用シナリオ, 'good');
  assert.equal(golden.設定.月別の予測範囲, '企画中も含む');
  const scope = {
    // 月別の表に入れる案件の範囲「企画中も含む」は見送りの案件を除く全部（build_yojitsu.py の in_scope）
    all: (id) => stage.get(id) !== 'declined',
    landing: (id) => probability.get(id) !== null && probability.get(id) >= landing,
    contracted: (id) => probability.get(id) === 10000,
  };
  const flows = Object.fromEntries(Object.entries(scope).map(([name, includeProject]) => [name,
    forecastCashflowByMonth(versions, {categories, scenario: SCENARIO[golden.設定.採用シナリオ], includeProject})]));
  const at = (flow, ids, month) => ids.reduce((sum, id) => sum + (flow.get(id)?.get(`${month}-01`) ?? 0), 0);
  const ids = (direction) => categories.filter((c) => !direction || c.direction === direction).map((c) => c.id);
  for (const c of categories) assertMonthlyRow(`予測/${c.label}`, (m) => at(flows.all, [c.id], m), periods);
  assertMonthlyRow('予測/入金計', (m) => at(flows.all, ids('in'), m), periods);
  assertMonthlyRow('予測/出金計', (m) => at(flows.all, ids('out'), m), periods);
  assertMonthlyRow('予測全部', (m) => at(flows.all, ids(), m), periods);
  assertMonthlyRow('予測着地', (m) => at(flows.landing, ids(), m), periods);
  assertMonthlyRow('予測契約', (m) => at(flows.contracted, ids(), m), periods);
  // golden に案件不明の予測の行は無い（予測の版は案件を外部キーで持つ）
  assert.deepEqual(golden.印.予測の案件不明, []);
});

test('FR-REV-YOJITSU-017 FR-REV-YOJITSU-035 活動記録の実績件数（稼ぎ方×ステップ×期間と、ステップ×月）は golden と一致し、4段の実績件数の合計が行動の表の合計と一致する', async (t) => {
  const db = await openTestDb({t});
  const {projectId, steps, periods, earningCode} = await load(db);
  // 種の全部の行が案件を持つ（作品の無い段の2行は企画メモの段階の案件の行）
  assert.ok(seed.活動記録.every((a) => a.案件コード !== null));
  assert.deepEqual(seed.活動記録.filter((a) => ['YJ-P31', 'YJ-P32'].includes(a.案件コード)).map((a) => [a.日付, a.案件コード, a.ステップ]),
    [['2026-10-15', 'YJ-P31', '面談'], ['2026-11-19', 'YJ-P32', '面談']]);
  const tallies = await store.readActivityTallies(db, 1, [...projectId.values()]);
  const counted = countActivitySteps(tallies, {steps, periods});
  // ステップの無い行（その他）は数えない。稼ぎ方の決まらない行は無い
  assert.deepEqual(counted.skipped, {noStep: seed.活動記録.filter((a) => a.ステップ === 'その他').length, noEarningType: 0});
  for (const g of golden.行動.目標件数と実績件数) {
    const earning = earningCode.get(g.稼ぎ方);
    const yearNo = periods.find((p) => p.name === g.期間).yearNo;
    assert.equal(counted.byPeriod.get(`${earning}|${STEP[g.ステップ]}|${yearNo}`) ?? 0, g.実績件数, `${g.稼ぎ方} ${g.ステップ} ${g.期間}`);
  }
  // 稼ぎ方×ステップ×期間の合計（行動の表の合計）が、ステップ×月の合計（4段の行動の実績件数）とも、golden の実績件数の合計とも同じ
  const sum = (values) => [...values].reduce((a, b) => a + b, 0);
  const goldenTotal = sum(golden.行動.目標件数と実績件数.map((g) => g.実績件数));
  assert.equal(sum(counted.byPeriod.values()), goldenTotal);
  assert.equal(sum([...counted.byMonth].filter(([key]) => periods.some((p) => key.slice(-7) >= ym(p.startsOn) && key.slice(-7) <= ym(p.ends))).map(([, n]) => n)), goldenTotal);
  for (const [label, code] of Object.entries(STEP)) {
    assertMonthlyRow(`行動実績/${label}`, (m) => counted.byMonth.get(`${code}|${m}`) ?? 0, periods);
  }
});

test('FR-REV-YOJITSU-029 FR-REV-YOJITSU-037 携わった案件数（成果物のある行を月×案件で1回）が golden と一致し、活動記録の行の中身は記録した本人にだけ返る', async (t) => {
  const db = await openTestDb({t});
  const {owner, projectId, workId, periods} = await load(db);
  const tallies = await store.readActivityTallies(db, 1, [...projectId.values()]);
  const engaged = engagedProjectCounts(tallies);
  assertMonthlyRow('案件数実績', (m) => engaged.get(m) ?? 0, periods);
  // 行の中身は記録した本人（種の持ち主）にだけ。種の行と同じ値で読める
  const mine = await store.readActivityRecords(db, 1, [...projectId.values()], {viewerUserId: owner});
  const loaded = seed.活動記録;
  assert.equal(mine.length, loaded.length);
  const codeOf = new Map([...projectId].map(([code, id]) => [id, code]));
  const workCode = new Map([...workId].map(([code, id]) => [id, code]));
  const pick = (r) => [codeOf.get(r.projectId), r.occurredOn, r.counterparty, r.summary, r.deliverable, r.nextAction, r.nextDueOn, r.result, r.workId === null ? null : workCode.get(r.workId)];
  const want = (a) => [a.案件コード, a.日付, a.相手, a.したこと, a.成果物, a.次の一手, a.期日, RESULT[a.result], a.work_code];
  const sort = (rows) => rows.map((r) => JSON.stringify(r)).sort();
  assert.deepEqual(sort(mine.map(pick)), sort(loaded.map(want)));
  assert.deepEqual(await store.readActivityRecords(db, 1, [...projectId.values()], {viewerUserId: EDITOR}), []);
});
