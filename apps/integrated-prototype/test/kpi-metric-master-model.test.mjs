// 指標マスタ（行動指標の計画 段B #9）の純関数（src/revenue/metrics/metric-master-model.mjs）を、DB を使わずに確かめる。
// 期待値は要件 docs/requirements/revenue/kpi-scenario-forecast.md の FR-REV-KPI-017・019 と、ontology の「行動の段」から持ってくる。架空の値だけを使う
import test from 'node:test';
import assert from 'node:assert/strict';
import {normalizeMetricMasterInput, effectiveMetricVersionId, metricMasterView, foldedStepCounts, attachStepSettings, METRIC_ROLES}
  from '../src/revenue/metrics/metric-master-model.mjs';

// 参照表の行（移行 0012 の稼ぎ方と集計の3ステップ。細目は架空の試験用の行）
const EARNING_TYPES = [{code: 'acquisition', sort_order: 1}, {code: 'consignment', sort_order: 2}, {code: 'own_investment', sort_order: 3},
  {code: 'committee', sort_order: 4}, {code: 'contract_work', sort_order: 5}];
const ACTION_STEPS = [{code: 'meeting', parent_code: null, sort_order: 1}, {code: 'proposal', parent_code: null, sort_order: 2},
  {code: 'contract', parent_code: null, sort_order: 3}, {code: 'memo_x', parent_code: 'meeting', sort_order: 11},
  {code: 'estimate_x', parent_code: 'proposal', sort_order: 12}, {code: 'sheet_x', parent_code: 'proposal', sort_order: 13},
  {code: 'sign_x', parent_code: 'contract', sort_order: 14}];
const refs = {earningTypes: EARNING_TYPES, actionSteps: ACTION_STEPS};
const chain = (role, earningType, steps) => ({role, earningType, steps: steps.map((step) => ({step}))});
const input = (chains, overrides = {}) => ({previousVersionNo: 0, createdOn: '2026-10-11', basis: '架空の最初の版', chains, ...overrides});
const fields = (n) => n.errors.map((e) => e.field);

test('FR-REV-KPI-017 FR-REV-KPI-019 入力の読み取り: 役×稼ぎ方×段の対応を役の並び・稼ぎ方の並びにそろえ、段は seq の順で、畳む先は細目なら親・集計のステップならそれ自身。状態の既定は仮置き', () => {
  const n = normalizeMetricMasterInput(input([
    chain('sales_selling', 'acquisition', ['memo_x', 'sheet_x', 'sign_x']),
    chain('producer', 'contract_work', ['memo_x', 'estimate_x', 'proposal', 'contract']),
    chain('sales_sourcing', 'consignment', ['meeting', 'proposal', 'sign_x']),
    chain('producer', 'own_investment', ['memo_x', 'sign_x']),
  ]), refs);
  assert.equal(n.ok, true, JSON.stringify(n.errors));
  assert.deepEqual(n.value.chains.map((c) => `${c.role}:${c.earningType}`),
    ['producer:own_investment', 'producer:contract_work', 'sales_sourcing:consignment', 'sales_selling:acquisition']);
  assert.equal(n.value.stepCount, 12);
  assert.deepEqual(n.value.chains[1].steps.map((s) => [s.seq, s.step, s.foldsTo, s.status]),
    [[1, 'memo_x', 'meeting', 'provisional'], [2, 'estimate_x', 'proposal', 'provisional'], [3, 'proposal', 'proposal', 'provisional'], [4, 'contract', 'contract', 'provisional']]);
  assert.deepEqual(foldedStepCounts(n.value.chains[1]), {meeting: 1, proposal: 2, contract: 1});
  assert.deepEqual(METRIC_ROLES.map((r) => [r.code, r.group]), [['producer', 'producer'], ['sales_sourcing', 'sales'], ['sales_selling', 'sales']]);
});

test('FR-REV-KPI-017 FR-REV-KPI-019 入力の読み取りは、決まった役・参照表の稼ぎ方と段・K-9 の状態だけを受け、畳む先が面談→提案→契約の順に戻る段・同じ役×稼ぎ方・同じ稼ぎ方×段を断る', () => {
  const bad = (chains, overrides) => normalizeMetricMasterInput(input(chains, overrides), refs);
  assert.deepEqual(fields(bad([chain('director', 'acquisition', ['meeting'])])), ['chains.0.role']);
  assert.deepEqual(fields(bad([chain('producer', 'crowdfunding', ['meeting'])])), ['chains.0.earningType']);
  assert.deepEqual(fields(bad([chain('producer', 'committee', ['meeting', 'unknown_step'])])), ['chains.0.steps.1.step']);
  // 提案 → 面談（細目の親が面談）は順に戻る。同じ畳む先（提案の細目2つ）は続けてよい
  assert.deepEqual(fields(bad([chain('producer', 'committee', ['proposal', 'memo_x'])])), ['chains.0.steps.1.step']);
  assert.equal(bad([chain('producer', 'committee', ['estimate_x', 'sheet_x', 'proposal'])]).ok, true);
  assert.deepEqual(fields(bad([chain('producer', 'committee', ['meeting']), chain('producer', 'committee', ['proposal'])])), ['chains.1']);
  // 同じ稼ぎ方×段を2つの役に置かない（設定の行の率・1件の時間は稼ぎ方×段で引くため）
  assert.deepEqual(fields(bad([chain('sales_sourcing', 'acquisition', ['meeting']), chain('sales_selling', 'acquisition', ['meeting'])])), ['chains.1.steps.0.step']);
  const status = normalizeMetricMasterInput(input([{role: 'producer', earningType: 'committee', steps: [{step: 'meeting', status: 'guessed'}]}]), refs);
  assert.deepEqual(fields(status), ['chains.0.steps.0.status']);
  assert.deepEqual(fields(bad([], {})), ['chains']);
  assert.deepEqual(fields(bad([chain('producer', 'committee', [])])), ['chains.0.steps']);
  assert.deepEqual(fields(bad([chain('producer', 'committee', ['meeting'])], {createdOn: '2026-02-30'})), ['createdOn']);
  assert.deepEqual(fields(bad([chain('producer', 'committee', ['meeting'])], {previousVersionNo: -1})), ['previousVersionNo']);
  assert.deepEqual(fields(bad([chain('producer', 'committee', ['meeting'])], {basis: 'x'.repeat(1001)})), ['basis']);
  const long = Array.from({length: 21}, () => 'proposal');
  assert.ok(fields(bad([chain('producer', 'committee', long)])).includes('chains.0.steps'));
});

// ontology（brain wiki/01_rules/ontology.md）の「行動の段」の表にある役×稼ぎ方の組
const ONTOLOGY_PAIRS = ['producer|contract_work', 'producer|own_investment', 'producer|committee',
  'sales_sourcing|acquisition', 'sales_sourcing|consignment', 'sales_selling|acquisition', 'sales_selling|consignment'];

test('FR-REV-KPI-017 FR-REV-KPI-019 役×稼ぎ方は ontology の「行動の段」の表の組（プロデューサー＝制作受託・自社出資・製作委員会、営業の仕入れと売り＝買付・販売委託）だけを受け、表に無い組を断る', () => {
  const tried = [];
  for (const role of ['producer', 'sales_sourcing', 'sales_selling']) {
    for (const {code} of EARNING_TYPES) {
      const n = normalizeMetricMasterInput(input([chain(role, code, ['meeting', 'proposal'])]), refs);
      const allowed = ONTOLOGY_PAIRS.includes(`${role}|${code}`);
      assert.deepEqual(fields(n), allowed ? [] : ['chains.0.earningType'], `${role}×${code}`);
      if (allowed) tried.push(`${role}|${code}`);
    }
  }
  assert.deepEqual(tried.sort(), [...ONTOLOGY_PAIRS].sort());
  // 表に無い組が版の途中にあっても、その役×稼ぎ方の行だけを指して断る
  const mixed = normalizeMetricMasterInput(input([chain('producer', 'committee', ['meeting']), chain('sales_selling', 'own_investment', ['proposal'])]), refs);
  assert.deepEqual(fields(mixed), ['chains.1.earningType']);
});

test('FR-REV-KPI-019 有効な版は段の行が step_count にそろった版のうち最新の version_no で、欠けた版は有効にしない', () => {
  const versions = [{id: 1, version_no: 1, step_count: 2}, {id: 2, version_no: 2, step_count: 2}, {id: 3, version_no: 3, step_count: 3}];
  const rows = (id, n) => Array.from({length: n}, () => ({metric_version_id: id}));
  assert.equal(effectiveMetricVersionId(versions, [...rows(1, 2), ...rows(2, 2), ...rows(3, 2)]), 2);
  assert.equal(effectiveMetricVersionId(versions, [...rows(1, 2), ...rows(2, 2), ...rows(3, 3)]), 3);
  assert.equal(effectiveMetricVersionId(versions, rows(1, 1)), null);
  assert.equal(effectiveMetricVersionId([], []), null);
});

test('FR-REV-KPI-019 段の率と1件の時間は、設定の行（範囲が稼ぎ方×ステップ）の値を稼ぎ方×段で添えるだけで、無ければ null（0 で埋めない）', () => {
  const view = metricMasterView({version_no: 1, step_count: 2, created_on: '2026-10-11', basis: null}, [
    {role: 'sales_sourcing', earning_type: 'acquisition', seq: 2, step: 'sheet_x', status: 'provisional', parent_code: 'proposal', profit_source: 4, earning_sort_order: 1},
    {role: 'sales_sourcing', earning_type: 'acquisition', seq: 1, step: 'memo_x', status: 'confirmed', parent_code: 'meeting', profit_source: 4, earning_sort_order: 1},
  ], {effective: true});
  assert.deepEqual(view.chains[0].steps.map((s) => [s.seq, s.step, s.foldsTo, s.status]), [[1, 'memo_x', 'meeting', 'confirmed'], [2, 'sheet_x', 'proposal', 'provisional']]);
  const settings = [
    {variableKey: 'conversion_rate', scope: 'earning_type_step', earningType: 'acquisition', step: 'memo_x', value: {kind: 'bps', value: 4321}, status: 'provisional', versionNo: 2},
    {variableKey: 'step_hours', scope: 'earning_type_step', earningType: 'acquisition', step: 'memo_x', value: {kind: 'x100', value: 275}, status: 'confirmed', versionNo: 1},
    // 範囲が稼ぎ方の行・別の稼ぎ方の行は添えない
    {variableKey: 'conversion_rate', scope: 'earning_type', earningType: 'acquisition', step: null, value: {kind: 'bps', value: 9999}, status: 'provisional', versionNo: 1},
    {variableKey: 'conversion_rate', scope: 'earning_type_step', earningType: 'consignment', step: 'sheet_x', value: {kind: 'bps', value: 1111}, status: 'provisional', versionNo: 1},
  ];
  const attached = attachStepSettings(view, settings);
  assert.deepEqual(attached.chains[0].steps.map((s) => [s.step, s.conversionBps, s.conversionStatus, s.hoursX100, s.hoursStatus]),
    [['memo_x', 4321, 'provisional', 275, 'confirmed'], ['sheet_x', null, null, null, null]]);
  // 添える前の形は変えない（値は設定の行のまま写すだけ）
  assert.equal('conversionBps' in view.chains[0].steps[0], false);
});
