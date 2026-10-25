// 案件収支の予実の純関数（src/revenue/yojitsu/yojitsu-model.mjs）のうち、目標・計画の版と期間、行動の設定（フェーズ1の仕様書 #11）の分を確かめる。
// 期待値は要件 docs/requirements/revenue/project-cashflow-forecast-actual.md の FR-REV-YOJITSU-003・006・008〜012・014 と、
// 行動指標の計画（会社ルート plans/2026-10-09-sales-producer-kpi.md）の K2-12・K2-18 から持ってくる。DB を使わない。架空の値だけを使う
import test from 'node:test';
import assert from 'node:assert/strict';
import * as model from '../src/revenue/yojitsu/yojitsu-model.mjs';

const target = (overrides = {}) => ({periodId: 1, previousVersionNo: 0, kind: 'self', scope: 'all', unit: 'period_total', basisKind: 'amount',
  amountYen: 123456789, status: 'provisional', decidedOn: '2026-10-02', decidedBy: '架空の代表', basis: '架空の目標', ownerUserId: 5, ...overrides});

test('FR-REV-YOJITSU-010 期間の合計は12か月に整数で均等に割り、端数は最後の月に寄せ、12か月の合計は元の値と同じ', () => {
  assert.deepEqual(model.splitAcrossMonths(1000003), [...Array(11).fill(83333), 83340]);
  assert.deepEqual(model.splitAcrossMonths(1200000), Array(12).fill(100000), '割り切れるときは12か月とも同じ');
  assert.deepEqual(model.splitAcrossMonths(11), [...Array(11).fill(0), 11], '12円未満は最後の月に全部');
  assert.deepEqual(model.splitAcrossMonths(0), Array(12).fill(0));
  for (const total of [305486522, 285234557, 9007199254740991]) {
    const months = model.splitAcrossMonths(total);
    assert.equal(months.reduce((a, b) => a + b, 0), total);
    assert.ok(months.every(Number.isSafeInteger));
    assert.ok(months.at(-1) - months[0] < 12 && months.at(-1) >= months[0], '最後の月は端数（0〜11円）だけ多い');
  }
  for (const bad of [-1, 1.5, null, '1200000', Number.MAX_SAFE_INTEGER + 1]) assert.throws(() => model.splitAcrossMonths(bad), /0以上の整数/);
  // 単位「毎月」は同じ額を12か月
  assert.deepEqual(model.monthlyAmounts(500001, 'monthly'), Array(12).fill(500001));
  assert.deepEqual(model.monthlyAmounts(1000003, 'period_total'), model.splitAcrossMonths(1000003));
  assert.throws(() => model.monthlyAmounts(1, 'yearly'), /単位/);
});

test('FR-REV-YOJITSU-003 期間は月初の日に始まる12か月で、n年目は n−1年目のちょうど12か月後に始まる', () => {
  assert.deepEqual(model.periodMonths('2026-10-01'), ['2026-10-01', '2026-11-01', '2026-12-01', '2027-01-01', '2027-02-01', '2027-03-01',
    '2027-04-01', '2027-05-01', '2027-06-01', '2027-07-01', '2027-08-01', '2027-09-01']);
  assert.deepEqual(model.periodStarts('2026-10-01'), ['2026-10-01', '2027-10-01', '2028-10-01', '2029-10-01', '2030-10-01']);
  assert.deepEqual(model.periodStarts('2027-01-01'), ['2027-01-01', '2028-01-01', '2029-01-01', '2030-01-01', '2031-01-01']);
  assert.equal(model.addMonths('2026-12-01', 1), '2027-01-01');
  assert.equal(model.addMonths('2027-01-01', -1), '2026-12-01');
  for (const bad of ['2026-10-02', '2026-13-01', '2026-10', '２０２６-10-01']) assert.throws(() => model.periodMonths(bad), /月初の日/);
});

test('FR-REV-YOJITSU-008 K2-18 人件費×倍率の目標は額を持たず、倍率を入れなければ本人 3倍・会社 2倍を入れる', () => {
  const self = model.normalizeTargetInput(target({basisKind: 'labor_cost_multiple', amountYen: null}));
  assert.equal(self.ok, true, JSON.stringify(self.errors));
  assert.equal(self.value.multiplierX100, 300);
  assert.equal(self.value.amountYen, null);
  const company = model.normalizeTargetInput(target({kind: 'company', basisKind: 'labor_cost_multiple', amountYen: null}));
  assert.equal(company.value.multiplierX100, 200);
  // 代表が変えた倍率は版に残る（固定にしない）
  assert.equal(model.normalizeTargetInput(target({basisKind: 'labor_cost_multiple', amountYen: null, multiplierX100: 350})).value.multiplierX100, 350);
  // 根拠が額の目標は額が要り、倍率を持たない。既定の倍率も入れない
  const amount = model.normalizeTargetInput(target());
  assert.equal(amount.ok, true);
  assert.equal(amount.value.multiplierX100, null);
  const fields = (input) => model.normalizeTargetInput(input).errors.map((e) => e.field);
  assert.deepEqual(fields(target({amountYen: null})), ['amountYen']);
  assert.deepEqual(fields(target({multiplierX100: 300})), ['multiplierX100']);
  assert.deepEqual(fields(target({basisKind: 'labor_cost_multiple'})), ['amountYen'], '人件費×倍率の目標は額を持たない（読むたびに計算する）');
  assert.deepEqual(fields(target({basisKind: 'labor_cost_multiple', amountYen: null, multiplierX100: 0})), ['multiplierX100']);
  assert.deepEqual(fields(target({basisKind: 'labor_cost_multiple', amountYen: null, unit: 'monthly'})), ['unit']);
  assert.deepEqual(fields(target({basisKind: 'labor_cost_multiple', amountYen: null, scope: 'production_share'})), ['scope']);
  // 源泉別の目標（5つ）は範囲が全体の目標だけ
  assert.equal(model.normalizeTargetInput(target({sources: {1: 1000, 4: 2000}})).value.sources[4], 2000);
  assert.deepEqual(fields(target({scope: 'production_share', unit: 'monthly', sources: {1: 1000}})), ['sources.1']);
  assert.deepEqual(fields(target({kind: 'team', amountYen: 1.5, decidedOn: '2026-02-30', ownerUserId: null, status: 'active'})).sort(),
    ['amountYen', 'decidedOn', 'kind', 'ownerUserId', 'status'].sort());
});

test('FR-REV-YOJITSU-008 FR-REV-YOJITSU-012 FR-REV-YOJITSU-014 K-8 有効な目標は期間×種類×範囲ごとの最新の版、有効な計画は期間ごとの最新の採用の記録が指す版（戻すと古い版が有効に戻る）、有効な設定は変数×範囲ごとの最新の版', () => {
  const rows = [
    {id: 1, period_id: 10, target_kind: 'self', target_scope: 'all', version_no: 1},
    {id: 2, period_id: 10, target_kind: 'self', target_scope: 'all', version_no: 2},
    {id: 3, period_id: 10, target_kind: 'company', target_scope: 'all', version_no: 1},
    {id: 4, period_id: 11, target_kind: 'self', target_scope: 'all', version_no: 1},
    {id: 5, period_id: 10, target_kind: 'self', target_scope: 'production_share', version_no: 1},
  ];
  assert.deepEqual([...model.latestTargetIds(rows)].sort(), [2, 3, 4, 5]);
  // 採用の記録の版の番号ではなく、記録の連番の新しい行で決める（第2版を採用したあとに第1版へ戻した）
  const adoptions = [{period_id: 10, seq: 1, plan_version_id: 100}, {period_id: 10, seq: 3, plan_version_id: 100}, {period_id: 10, seq: 2, plan_version_id: 101},
    {period_id: 11, seq: 1, plan_version_id: 200}];
  assert.deepEqual([...model.adoptedPlanVersionIds(adoptions)].sort(), [100, 200]);
  const settings = [
    {variable_key: 'conversion_rate', scope: 'earning_type_step', earning_type: 'acquisition', step: 'meeting', version_no: 1, value_bps: 5000},
    {variable_key: 'conversion_rate', scope: 'earning_type_step', earning_type: 'acquisition', step: 'meeting', version_no: 2, value_bps: 4500},
    {variable_key: 'conversion_rate', scope: 'earning_type_step', earning_type: 'acquisition', step: 'proposal', version_no: 1, value_bps: 3000},
  ];
  assert.deepEqual(model.latestSettings(settings).map((r) => [r.step, r.version_no]), [['meeting', 2], ['proposal', 1]]);
  assert.deepEqual(model.settingValue({value_bps: null, value_x100: null, value_months: 2, value_yen: null}), {kind: 'months', value: 2});
  assert.throws(() => model.settingValue({value_bps: 1, value_x100: null, value_months: 2, value_yen: null}), /ちょうど1つ/);
});

test('FR-REV-YOJITSU-006 FR-REV-YOJITSU-009 目標の額・倍率・源泉別・根拠は owner 本人にだけ返し、人件費×倍率は報酬が無い間は null（未接続）', () => {
  const row = {id: 7, period_id: 1, year_no: 1, target_kind: 'self', target_scope: 'all', version_no: 2, basis_kind: 'amount', amount_yen: 285234557,
    multiplier_x100: null, source1_yen: 1234567, source2_yen: null, source3_yen: null, source4_yen: null, source5_yen: null, unit: 'period_total',
    basis: '架空の目標', status: 'provisional', decided_on: '2026-11-16', decided_by: '架空の代表', owner_user_id: 5};
  const own = model.targetView(row, {viewerUserId: 5, effective: true});
  assert.equal(own.resolution, 'amount');
  assert.equal(own.amountYen, 285234557);
  assert.equal(own.sources[1], 1234567);
  assert.equal(own.basis, '架空の目標');
  for (const viewer of [2, null, undefined]) {
    const other = model.targetView(row, {viewerUserId: viewer, effective: true});
    assert.equal(other.resolution, 'owner_only');
    assert.deepEqual([other.amountYen, other.multiplierX100, other.sources, other.basis], [null, null, null, null]);
    assert.equal(other.versionNo, 2, '項目は残す');
    assert.equal(other.isOwner, false);
  }
  const labor = {...row, basis_kind: 'labor_cost_multiple', amount_yen: null, multiplier_x100: 300};
  const unconnected = model.targetView(labor, {viewerUserId: 5, effective: true});
  assert.deepEqual([unconnected.resolution, unconnected.amountYen, unconnected.multiplierX100], ['unconnected', null, 300]);
  // 報酬の行がつながったら、12か月の合計×倍率（料率の額と同じく 0 に向かって切り捨て）。架空の人件費
  assert.equal(model.targetView(labor, {viewerUserId: 5, annualCompensationYen: 4567891, effective: true}).amountYen, 13703673);
  assert.equal(model.targetView({...labor, multiplier_x100: 250}, {viewerUserId: 5, annualCompensationYen: 4567891, effective: true}).amountYen, 11419727);
  assert.equal(model.targetView(labor, {viewerUserId: 2, annualCompensationYen: 4567891, effective: true}).amountYen, null, '本人以外には計算した額も返さない');
});

test('FR-REV-YOJITSU-006 第1版の計画の額は owner 本人だけ、第2版以降の額は本人以外にも返す', () => {
  const amounts = [{earning_type: 'acquisition', amount_yen: 49573601}, {earning_type: 'consignment', amount_yen: 9430308}];
  const first = {id: 1, period_id: 1, year_no: 1, version_no: 1, owner_user_id: 5, status: 'provisional', basis: '目標（会社）の仮置き', created_on: '2026-10-02'};
  const own = model.planView(first, amounts, {viewerUserId: 5, effective: true});
  assert.equal(own.visibility, 'visible');
  assert.equal(own.totalYen, 59003909);
  const other = model.planView(first, amounts, {viewerUserId: 2, effective: true});
  assert.equal(other.visibility, 'owner_only');
  assert.deepEqual(other.amounts, [{earningType: 'acquisition', amountYen: null}, {earningType: 'consignment', amountYen: null}], '稼ぎ方の行は残して額を null');
  assert.deepEqual([other.totalYen, other.basis], [null, null]);
  const second = model.planView({...first, id: 2, version_no: 2, basis: '架空の改め'}, amounts, {viewerUserId: 2, effective: true});
  assert.equal(second.visibility, 'visible');
  assert.equal(second.totalYen, 59003909);
});
