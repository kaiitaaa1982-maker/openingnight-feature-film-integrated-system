// 指標マスタ（行動指標の計画 段B #9）の架空の種（test/fixtures/kpi-metrics/seed.json）を scripts/seed-kpi-metrics-demo.mjs で DB に入れ、
// store の読み取り（readMetricMaster・readEffectiveSettings）と model（attachStepSettings・foldedStepCounts）の結果が、src を読まずに作った golden
// （test/fixtures/kpi-metrics/expected.json。build-expected.mjs）と一致することを確かめる。種の対応が ontology の「行動の段」の表と同じことと、
// 種の設定の行の値が申し送りの §行動の表・§仮置きの値のままであることも、表をここに写して確かめる（golden は種から作るので、それだけでは種のずれを見ない）。期待値は要件 docs/requirements/revenue/kpi-scenario-forecast.md の FR-REV-KPI-017・019 と J-13。
// ON_TEST_DB=pg で同じ試験が PostgreSQL で流れる。架空のデータだけを使う
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {openTestDb} from './test-db.mjs';
import * as planning from '../src/planning/planning-store.mjs';
import * as store from '../src/revenue/revenue-store.mjs';
import {attachStepSettings, foldedStepCounts} from '../src/revenue/metrics/metric-master-model.mjs';
import {seedKpiMetrics, readKpiMetricsSeed} from '../scripts/seed-kpi-metrics-demo.mjs';
import {EXPECTED_PATH, expectedText} from './fixtures/kpi-metrics/build-expected.mjs';

const ADMIN = 1; // 組織1の管理者（試作の行）
const seed = readKpiMetricsSeed();
const expected = JSON.parse(readFileSync(EXPECTED_PATH, 'utf8'));
const count = async (db, table, where = 'org_id=1') => Number((await db.get(`SELECT COUNT(*) AS n FROM ${table} WHERE ${where}`)).n);
const settingKey = (s) => [s.variableKey, s.scope, s.earningType ?? '', s.step ?? ''].join('|');

// 読み取りの結果を golden の形にそろえる
async function readAsGolden(db, orgId) {
  const [view] = await store.readMetricMaster(db, orgId);
  const settings = await store.readEffectiveSettings(db, orgId);
  const attached = attachStepSettings(view, settings);
  const roleGroups = {};
  for (const c of attached.chains) {
    roleGroups[c.roleGroup] ??= [];
    if (!roleGroups[c.roleGroup].includes(c.earningType)) roleGroups[c.roleGroup].push(c.earningType);
  }
  return {
    metricMaster: {versionNo: attached.versionNo, stepCount: attached.stepCount, chains: attached.chains.map((c) => ({role: c.role, roleGroup: c.roleGroup,
      earningType: c.earningType, profitSource: c.profitSource,
      steps: c.steps.map((s) => ({seq: s.seq, step: s.step, foldsTo: s.foldsTo, status: s.status, conversionBps: s.conversionBps, hoursX100: s.hoursX100})),
      folded: foldedStepCounts(c)}))},
    roleGroups,
    settings: settings.map((s) => ({variableKey: s.variableKey, scope: s.scope, earningType: s.earningType, step: s.step, value: s.value, status: s.status,
      versionNo: s.versionNo})).sort((a, b) => (settingKey(a) < settingKey(b) ? -1 : settingKey(a) > settingKey(b) ? 1 : 0)),
  };
}

test('FR-REV-KPI-019 架空の種の指標マスタ（対応・畳む先・状態）と、段に添える率と1件の時間・設定の行が golden と一致し、2回流しても増えない', async (t) => {
  assert.equal(expectedText().replace(/\r\n/g, '\n'), readFileSync(EXPECTED_PATH, 'utf8').replace(/\r\n/g, '\n'), 'golden は今の種から作り直してある');
  const db = await openTestDb({t});
  const first = await seedKpiMetrics(db, {orgId: 1, createdBy: ADMIN});
  assert.deepEqual(first, {steps: {added: seed.steps.length, existing: 0}, metricMaster: {added: true, versionNo: 1},
    settings: {added: seed.settings.length, existing: 0, differing: []}});
  const actual = await readAsGolden(db, 1);
  assert.deepEqual(actual.metricMaster, expected.metricMaster);
  assert.deepEqual(actual.roleGroups, expected.roleGroups);
  assert.deepEqual(actual.settings, expected.settings);
  const steps = new Map((await planning.listActionSteps(db)).map((s) => [s.code, s.parent_code]));
  assert.deepEqual(expected.detailSteps.map((s) => [s.code, steps.get(s.code)]), expected.detailSteps.map((s) => [s.code, s.foldsTo]));
  // 2回目は何も足さない
  const before = [await count(db, 'kpi_metric_versions'), await count(db, 'kpi_metric_steps'), await count(db, 'yojitsu_setting_versions'),
    await count(db, 'action_steps', '1=1')];
  const second = await seedKpiMetrics(db, {orgId: 1, createdBy: ADMIN});
  assert.deepEqual(second, {steps: {added: 0, existing: seed.steps.length}, metricMaster: {added: false, versionNo: 1},
    settings: {added: 0, existing: seed.settings.length, differing: []}});
  assert.deepEqual([await count(db, 'kpi_metric_versions'), await count(db, 'kpi_metric_steps'), await count(db, 'yojitsu_setting_versions'),
    await count(db, 'action_steps', '1=1')], before);
  // 別の組織には、参照表の細目の段を足し直さずに同じ対応を入れられる
  const other = await seedKpiMetrics(db, {orgId: 2, createdBy: 4});
  assert.deepEqual([other.steps.added, other.metricMaster.versionNo, other.settings.added], [0, 1, seed.settings.length]);
  assert.deepEqual((await readAsGolden(db, 2)).metricMaster, expected.metricMaster);
});

test('FR-REV-KPI-019 種はすでにある設定の行（変数×範囲の版）を上書きせず、種と違う値の行の鍵を返す（フェーズ1 #23a の種の行動の行と同じ行を持つため）', async (t) => {
  const db = await openTestDb({t});
  await store.addSettingVersion(db, 1, {variableKey: 'unit_amount', scope: 'earning_type', earningType: 'acquisition', previousVersionNo: 0,
    value: {kind: 'yen', value: 31345186}, status: 'provisional', basis: '架空の別の種の値'}, {createdBy: ADMIN});
  const result = await seedKpiMetrics(db, {orgId: 1, createdBy: ADMIN});
  assert.deepEqual([result.settings.added, result.settings.existing, result.settings.differing],
    [seed.settings.length - 1, 1, ['unit_amount|earning_type|acquisition|||']]);
  const unit = (await store.readEffectiveSettings(db, 1)).find((s) => s.variableKey === 'unit_amount' && s.earningType === 'acquisition');
  assert.deepEqual([unit.versionNo, unit.value], [1, {kind: 'yen', value: 31345186}]);
});

// ontology（brain wiki/01_rules/ontology.md）の「行動の段（ステップ。2026-10-10）」の表。括弧は畳む先
const ONTOLOGY = [
  ['プロデューサー', '制作受託', [['企画メモ', '面談'], ['予算割と見積', '提案'], ['提案', '提案'], ['契約', '契約']]],
  ['プロデューサー', '自社出資', [['企画書', '面談'], ['稟議の申請', '提案'], ['決裁', '契約'], ['出資の払込', '契約']]],
  ['プロデューサー', '製作委員会', [['打診', '面談'], ['内諾', '提案'], ['出資契約', '契約']]],
  ['営業（仕入れ）', '買付', [['権利元との面談', '面談'], ['条件書', '提案'], ['契約（MG）', '契約']]],
  ['営業（仕入れ）', '販売委託', [['権利元との面談', '面談'], ['条件書', '提案'], ['預かりの契約', '契約']]],
  ['営業（売り）', '買付', [['商品化', '面談'], ['取引先への提案', '提案'], ['採用', '契約']]],
  ['営業（売り）', '販売委託', [['商品化', '面談'], ['取引先への提案', '提案'], ['採用', '契約']]],
];

// 申し送り（会社ルート plans/2026-10-09-producer-sales-kpi-image.md、読む版 2931faf）の値。seed.json と golden から作らず、ここへ別に写す
// （受け入れ基準「初期値は申し送り §仮置きの値の表のまま」を、seed.json を変えて expected.json を作り直しただけでは緑にならない形で確かめる）。
// §行動の表: 稼ぎ方×段のコードごとの [次の段へ進む率（bp）, 1件の時間（100倍）]。最後の段（契約・採用など）は値を持たない。
// 売り側（商品化・取引先への提案）は買付と委託の両方に同じ値
const HANDOFF_STEPS = {
  contract_work: {planning_memo: [5000, 400], budget_estimate: [5000, 800], proposal: [3000, 800]},
  own_investment: {pitch_document: [5000, 800], approval_request: [7000, 600], approval_decision: [10000, 100]},
  committee: {committee_sounding: [3000, 400], informal_consent: [5000, 600]},
  acquisition: {rights_holder_meeting: [5000, 300], term_sheet: [3000, 800], productization: [8000, 600], buyer_proposal: [4000, 400]},
  consignment: {rights_holder_meeting: [5000, 300], term_sheet: [3000, 800], productization: [8000, 600], buyer_proposal: [4000, 400]},
};
// §仮置きの値（と §DB の「#11 の設定に足す行」の例）: [変数, 範囲, 稼ぎ方, 値の種類, 値]
const HANDOFF_VALUES = [
  ['work_hours', 'all', null, 'x100', 16000], // 月の業務時間 160時間（8時間×20日）
  // 1件の額（行動から生まれる取引）: 買付の窓口の売上600万円・委託700万円・受託は新しい受託の総製作費の標準2,500万円
  ['unit_amount', 'earning_type', 'acquisition', 'yen', 6_000_000],
  ['unit_amount', 'earning_type', 'consignment', 'yen', 7_000_000],
  ['unit_amount', 'earning_type', 'contract_work', 'yen', 25_000_000],
  ['deal_mg', 'earning_type', 'acquisition', 'yen', 400_000], // 買付の MG 40万円
  ['prep_cost', 'earning_type', 'acquisition', 'yen', 200_000], // 買付の商品化の費用 1件20万円
  // 成約後の実行の時間（1件の月の時間×月数）: 受託30時間×4か月・自社出資8時間×6か月・委員会4時間×12か月・買付13時間×2か月・委託3時間×12か月
  ['delivery_hours', 'earning_type', 'contract_work', 'x100', 3000], ['delivery_months', 'earning_type', 'contract_work', 'months', 4],
  ['delivery_hours', 'earning_type', 'own_investment', 'x100', 800], ['delivery_months', 'earning_type', 'own_investment', 'months', 6],
  ['delivery_hours', 'earning_type', 'committee', 'x100', 400], ['delivery_months', 'earning_type', 'committee', 'months', 12],
  ['delivery_hours', 'earning_type', 'acquisition', 'x100', 1300], ['delivery_months', 'earning_type', 'acquisition', 'months', 2],
  ['delivery_hours', 'earning_type', 'consignment', 'x100', 300], ['delivery_months', 'earning_type', 'consignment', 'months', 12],
  ['labor_share', 'all', null, 'bps', 4000], // 制作費のうち作り手（人）へ渡る割合 40%
  ['pass_rate', 'all', null, 'bps', 5000], // 段階を進める一手・条件の交渉が通る確率 50%
  // 契約までの月数 2か月（§DB の範囲は稼ぎ方）・買付と委託の窓口に出るまでの月数 3か月・窓口の支払いの間（窓口の比率で加重）2か月
  ...['contract_work', 'own_investment', 'committee', 'acquisition', 'consignment'].map((e) => ['months_to_contract', 'earning_type', e, 'months', 2]),
  ['months_to_window', 'earning_type', 'acquisition', 'months', 3], ['months_to_window', 'earning_type', 'consignment', 'months', 3],
  ['payment_lag', 'all', null, 'months', 2],
  ['rate_min_count', 'all', null, 'x100', 900], // 実績が9件以上たまったら実績の率を並べる
  ['rate_window', 'all', null, 'months', 12], // 通過率を測る期間（計画 K2-7 の既定。申し送りでなく計画から）
  // §DB の例: 窓口の売上の倍率 10000・回収の量（自社出資・委員会）10000・入金の遅れ 0・受託の実費の超過 100
  ['sales_multiplier', 'all', null, 'bps', 10000],
  ['recovery_amount', 'earning_type', 'own_investment', 'bps', 10000], ['recovery_amount', 'earning_type', 'committee', 'bps', 10000],
  ['payment_delay', 'all', null, 'months', 0],
  ['cost_overrun', 'earning_type', 'contract_work', 'bps', 100],
];

test('FR-REV-KPI-019 J-13 種の設定の行の値は申し送りの §行動の表・§仮置きの値・§DB の例のまま（ここへ別に写した表と、seed.json と、DB から読んだ有効な行の3つが一致する）', async (t) => {
  const handoff = [];
  for (const [earningType, steps] of Object.entries(HANDOFF_STEPS)) {
    for (const [step, [bps, hoursX100]] of Object.entries(steps)) {
      handoff.push([settingKey({variableKey: 'conversion_rate', scope: 'earning_type_step', earningType, step}), {kind: 'bps', value: bps}]);
      handoff.push([settingKey({variableKey: 'step_hours', scope: 'earning_type_step', earningType, step}), {kind: 'x100', value: hoursX100}]);
    }
  }
  for (const [variableKey, scope, earningType, kind, value] of HANDOFF_VALUES) handoff.push([settingKey({variableKey, scope, earningType}), {kind, value}]);
  const sorted = (rows) => [...rows].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  assert.equal(new Set(handoff.map(([key]) => key)).size, handoff.length, '写した表に同じ変数×範囲が2つない');
  assert.deepEqual(sorted(seed.settings.map((s) => [settingKey(s), s.value])), sorted(handoff), 'seed.json の設定の行');
  const db = await openTestDb({t});
  await seedKpiMetrics(db, {orgId: 1, createdBy: ADMIN});
  const settings = await store.readEffectiveSettings(db, 1);
  assert.deepEqual(sorted(settings.map((s) => [settingKey(s), s.value])), sorted(handoff), 'DB から読んだ有効な設定の行');
  // §仮置きの値の「受託の提案1件40時間」（§DB の例 4000）は、段の率の逆数で連ねた値（企画メモ4件×4時間＋予算割と見積2件×8時間＋提案8時間）
  const value = (variableKey, step) => settings.find((s) => s.variableKey === variableKey && s.earningType === 'contract_work' && s.step === step).value.value;
  const [memoRate, estimateRate] = [value('conversion_rate', 'planning_memo'), value('conversion_rate', 'budget_estimate')];
  assert.equal(value('step_hours', 'planning_memo') * 10000 * 10000 / (memoRate * estimateRate) + value('step_hours', 'budget_estimate') * 10000 / estimateRate
    + value('step_hours', 'proposal'), 4000);
});

test('FR-REV-KPI-017 種の対応は ontology の「行動の段」の表と同じ（役×稼ぎ方×段の並びと、面談・提案・契約への畳み方）', async (t) => {
  const db = await openTestDb({t});
  await seedKpiMetrics(db, {orgId: 1, createdBy: ADMIN});
  const [view] = await store.readMetricMaster(db, 1);
  const earningLabels = new Map((await planning.listEarningTypes(db)).map((e) => [e.code, e.label]));
  const stepLabels = new Map((await planning.listActionSteps(db)).map((s) => [s.code, s.label]));
  const key = (row) => `${row[0]}|${row[1]}`;
  const actual = view.chains.map((c) => [c.roleLabel, earningLabels.get(c.earningType), c.steps.map((s) => [stepLabels.get(s.step), stepLabels.get(s.foldsTo)])]);
  assert.deepEqual(actual.sort((a, b) => key(a).localeCompare(key(b))), [...ONTOLOGY].sort((a, b) => key(a).localeCompare(key(b))));
});

test('FR-REV-KPI-019 J-13 種と golden は架空の印を持ち、対応と値の状態はすべて仮置きで、報酬・家賃補助・目標の行と額の列を持たない', () => {
  for (const [name, json] of [['seed.json', seed], ['expected.json', expected]]) {
    assert.equal(json.fictional, true, name);
    const text = JSON.stringify(json);
    assert.doesNotMatch(text, /compensation|salar|wage|payroll|remuneration|target|報酬|家賃|給与|目標/i, name);
  }
  assert.ok(seed.metricMaster.chains.every((c) => c.steps.every((s) => s.status === 'provisional')));
  assert.ok(seed.settings.every((s) => s.status === 'provisional' && typeof s.basis === 'string'));
  // 窓口のコードが決まるまで（段B #12）窓口ごとの行を持たず、申し送りに値の無い変数（ビデオグラムの製造費）を埋めない
  assert.deepEqual(seed.settings.filter((s) => s.scope === 'channel' || s.scope === 'project' || s.variableKey === 'videogram_cost'), []);
});
