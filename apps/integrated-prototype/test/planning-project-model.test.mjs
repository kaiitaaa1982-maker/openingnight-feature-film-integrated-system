// 案件の登録の入力の読み取りと、売上率・ステップ・区分の符号の導き方（純関数。フェーズ1の仕様書 #10）。
// 期待値は要件 docs/requirements/revenue/project-cashflow-forecast-actual.md の対応表と FR から持ってくる。DB を使わない
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  PROJECT_TYPES, ASSUMPTION_STATUSES, normalizeProjectInput, normalizeStageChange, effectiveRevenueRate, rollUpStep, signedCashflowYen, isCalendarDate,
} from '../src/planning/project/project-model.mjs';

// 要件の「稼ぎ方×案件の型×売上の4区分の対応表」の行（参照表の行と同じ形）
const EARNING_TYPES = [
  {code: 'acquisition', label: '買付', project_type: 'acquisition', base_amount_kind: 'rights_revenue', rate_source: 'project'},
  {code: 'consignment', label: '販売委託', project_type: 'agency', base_amount_kind: 'rights_revenue', rate_source: 'project'},
  {code: 'own_investment', label: '自社出資', project_type: 'production', base_amount_kind: 'rights_revenue', rate_source: 'project'},
  {code: 'committee', label: '製作委員会', project_type: 'production', base_amount_kind: 'rights_revenue', rate_source: 'project'},
  {code: 'contract_work', label: '制作受託', project_type: 'contract_production', base_amount_kind: 'production_cost', rate_source: 'contract'},
];
const STAGES = [
  {code: 'declined', label: '見送り', probability_bps: 0, requires_reason: 1},
  {code: 'memo', label: '企画メモ', probability_bps: 1000, requires_reason: 0},
  {code: 'proposed', label: '提案済み', probability_bps: 4000, requires_reason: 0},
];
const ctx = {earningTypes: EARNING_TYPES, stages: STAGES};
const input = (overrides = {}) => ({code: 'FICT-1', title: '架空の案件', projectType: 'acquisition', earningType: 'acquisition', baseAmountYen: 1000000, ...overrides});
const fields = (result) => result.errors.map((e) => e.field);

test('FR-REV-YOJITSU-018 FR-REV-CWORK-014 案件の型は ontology の6つで、稼ぎ方は型と対応表の組だけを受け、稼ぎ方のある型では稼ぎ方が要る', () => {
  assert.deepEqual(PROJECT_TYPES, ['field_contract', 'production', 'acquisition', 'agency', 'sw_contract', 'contract_production']);
  const ok = normalizeProjectInput(input({title: '  架空の案件  ', counterpartyName: ' 架空の権利元 '}), ctx);
  assert.equal(ok.ok, true, JSON.stringify(ok.errors));
  assert.deepEqual(ok.value, {
    code: 'FICT-1', title: '架空の案件', projectType: 'acquisition', earningType: 'acquisition', baseAmountYen: 1000000, revenueRateBps: null,
    counterpartyName: '架空の権利元', keyPerson: null, startedOn: null, planningFolder: null, note: null, stage: null,
  });
  assert.deepEqual(fields(normalizeProjectInput(input({projectType: 'distribution'}), ctx)), ['projectType']);
  assert.deepEqual(fields(normalizeProjectInput(input({earningType: 'consignment'}), ctx)), ['earningType']);
  assert.deepEqual(fields(normalizeProjectInput(input({projectType: 'production', earningType: null}), ctx)), ['earningType'], '製作の型は自社出資か製作委員会を選ぶ');
  assert.equal(normalizeProjectInput(input({projectType: 'production', earningType: 'committee'}), ctx).ok, true);
  // 稼ぎ方の無い型（現場受託・受託開発）は稼ぎ方を持たない
  assert.equal(normalizeProjectInput(input({projectType: 'sw_contract', earningType: null, baseAmountYen: null}), ctx).ok, true);
  assert.deepEqual(fields(normalizeProjectInput(input({projectType: 'field_contract', earningType: 'acquisition'}), ctx)), ['earningType']);
  assert.deepEqual(fields(normalizeProjectInput(input({code: ' ', title: ''}), ctx)), ['code', 'title']);
});

test('FR-REV-YOJITSU-020 基準額と売上率は整数（円・bp）だけを受け、制作受託は案件の売上率を受けない', () => {
  for (const bad of [-1, 1000.5, '1000', Number.MAX_SAFE_INTEGER + 1, NaN]) assert.deepEqual(fields(normalizeProjectInput(input({baseAmountYen: bad}), ctx)), ['baseAmountYen'], String(bad));
  assert.equal(normalizeProjectInput(input({baseAmountYen: 0}), ctx).value.baseAmountYen, 0, '0円は0円のまま（未登録の null と分ける）');
  assert.equal(normalizeProjectInput(input({baseAmountYen: null}), ctx).value.baseAmountYen, null);
  for (const bad of [-1, 10001, 12.5, '1000']) assert.deepEqual(fields(normalizeProjectInput(input({revenueRateBps: bad}), ctx)), ['revenueRateBps'], String(bad));
  assert.equal(normalizeProjectInput(input({revenueRateBps: 10000}), ctx).value.revenueRateBps, 10000, '手数料を引いた後の額で届く入金の売上率 100%');
  assert.deepEqual(fields(normalizeProjectInput(input({projectType: 'contract_production', earningType: 'contract_work', revenueRateBps: 1000}), ctx)), ['revenueRateBps']);
  assert.deepEqual(fields(normalizeProjectInput(input({projectType: 'sw_contract', earningType: null, revenueRateBps: 1000}), ctx)), ['revenueRateBps'], '稼ぎ方の無い案件は売上率を持たない（DB も断る）');
  assert.deepEqual(fields(normalizeProjectInput(input({startedOn: '2026-02-30'}), ctx)), ['startedOn']);
  assert.equal(normalizeProjectInput(input({startedOn: '2028-02-29'}), ctx).value.startedOn, '2028-02-29');
  assert.deepEqual(fields(normalizeProjectInput(input({note: 'x'.repeat(2001)}), ctx)), ['note']);
});

test('FR-REV-YOJITSU-020 使う売上率は 案件の値 → 稼ぎ方の既定（最新の版・状態つき）の順で、無ければ null と理由。制作受託は受託の契約の版の率', () => {
  const acquisition = EARNING_TYPES[0];
  const defaultRate = {earning_type: 'acquisition', version_no: 3, revenue_rate_bps: 2000, status: 'provisional'};
  assert.deepEqual(effectiveRevenueRate({project: {revenue_rate_bps: 10000}, earningType: acquisition, defaultRate}), {bps: 10000, source: 'project', status: null, versionNo: null, reason: null});
  assert.deepEqual(effectiveRevenueRate({project: {revenue_rate_bps: 0}, earningType: acquisition, defaultRate}), {bps: 0, source: 'project', status: null, versionNo: null, reason: null}, '0 bp は空とみなさない');
  assert.deepEqual(effectiveRevenueRate({project: {revenue_rate_bps: null}, earningType: acquisition, defaultRate}), {bps: 2000, source: 'default', status: 'provisional', versionNo: 3, reason: null});
  assert.deepEqual(effectiveRevenueRate({project: {revenue_rate_bps: null}, earningType: acquisition, defaultRate: null}), {bps: null, source: 'default', status: null, versionNo: null, reason: 'default_unregistered'});
  // 制作受託は案件の売上率も既定も使わず、受託の契約の版の受託費率（版が無ければ null と理由。版のある場合は test/revenue-class-model.test.mjs）
  assert.deepEqual(effectiveRevenueRate({project: {revenue_rate_bps: null}, earningType: EARNING_TYPES[4], defaultRate}), {bps: null, source: 'contract', status: null, versionNo: null, reason: 'contract_version_unregistered'});
  assert.deepEqual(effectiveRevenueRate({project: {revenue_rate_bps: null}, earningType: null, defaultRate: null}), {bps: null, source: null, status: null, versionNo: null, reason: 'earning_type_unregistered'});
  // 既定の版の状態は K-9 の4つ（確認済み・監督申告・報道値・仮置き）
  assert.deepEqual(ASSUMPTION_STATUSES, ['confirmed', 'director_reported', 'press_reported', 'provisional']);
});

test('FR-REV-YOJITSU-019 段階の変更は参照表の段階だけを受け、入った日が要り、理由の要る段階（見送り）では理由が要る', () => {
  const ok = normalizeStageChange({stageCode: 'proposed', previousStageCode: 'memo', enteredOn: '2026-05-01', evidence: ' 架空の言質 '}, ctx);
  assert.deepEqual(ok, {ok: true, errors: [], value: {stageCode: 'proposed', previousStageCode: 'memo', enteredOn: '2026-05-01', evidence: '架空の言質', reason: null}});
  assert.deepEqual(fields(normalizeStageChange({stageCode: 'won', previousStageCode: null, enteredOn: '2026-05-01'}, ctx)), ['stageCode']);
  assert.deepEqual(fields(normalizeStageChange({stageCode: 'proposed', previousStageCode: 'unknown', enteredOn: '2026-05-01'}, ctx)), ['previousStageCode']);
  assert.deepEqual(fields(normalizeStageChange({stageCode: 'proposed', previousStageCode: 'proposed', enteredOn: '2026-05-01'}, ctx)), ['stageCode']);
  assert.deepEqual(fields(normalizeStageChange({stageCode: 'proposed', previousStageCode: null, enteredOn: '2026/05/01'}, ctx)), ['enteredOn']);
  assert.deepEqual(fields(normalizeStageChange({stageCode: 'declined', previousStageCode: 'memo', enteredOn: '2026-05-01', reason: ' '}, ctx)), ['reason']);
  assert.equal(normalizeStageChange({stageCode: 'declined', previousStageCode: 'memo', enteredOn: '2026-05-01', reason: '架空の理由'}, ctx).ok, true);
  // 登録と同時の最初の段階も同じ決まり
  assert.deepEqual(fields(normalizeProjectInput(input({stage: {code: 'declined', enteredOn: '2026-05-01'}}), ctx)), ['stage.reason']);
  assert.deepEqual(normalizeProjectInput(input({stage: {code: 'memo', enteredOn: '2026-05-01', evidence: '架空の言質'}}), ctx).value.stage,
    {code: 'memo', enteredOn: '2026-05-01', evidence: '架空の言質', reason: null});
});

test('FR-REV-YOJITSU-015 細目のステップは親の step へ畳み、親の無い行はそのまま、参照表に無いコードは null', () => {
  const steps = [
    {code: 'meeting', parent_code: null}, {code: 'proposal', parent_code: null}, {code: 'contract', parent_code: null},
    {code: 'fictional_offer', parent_code: 'contract'},
  ];
  assert.equal(rollUpStep(steps, 'fictional_offer'), 'contract');
  assert.equal(rollUpStep(steps, 'meeting'), 'meeting');
  assert.equal(rollUpStep(steps, 'other'), null, '「その他」など参照表に無いステップは数えない');
  assert.equal(rollUpStep(steps, null), null, 'ステップが空の行は数えない');
});

test('FR-REV-YOJITSU-024 区分の金額は正の整数で持ち、符号は区分の入出金で決める', () => {
  assert.equal(signedCashflowYen({direction: 'in'}, 1500000), 1500000);
  assert.equal(signedCashflowYen({direction: 'out'}, 1500000), -1500000);
  for (const bad of [0, -1, 1.5, '100']) assert.throws(() => signedCashflowYen({direction: 'in'}, bad), /正の整数/, String(bad));
  assert.throws(() => signedCashflowYen({direction: 'sideways'}, 1), /入出金/);
});

test('暦の日付だけを日付として受ける（月末・うるう年）', () => {
  for (const ok of ['2026-01-31', '2028-02-29', '2000-02-29', '2026-12-31']) assert.equal(isCalendarDate(ok), true, ok);
  for (const bad of ['2026-02-29', '1900-02-29', '2026-04-31', '2026-13-01', '2026-00-10', '2026-1-01', '２０２６-01-01', '', null]) assert.equal(isCalendarDate(bad), false, String(bad));
});
