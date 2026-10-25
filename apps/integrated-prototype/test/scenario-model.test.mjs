// シナリオの比較（段A）の計算（src/revenue/scenario/）を、別に書いた golden（test/fixtures/scenario/build-expected.mjs が全列挙で作る）と照らす。
// 期待値は計画（会社ルートの plans/2026-10-09-sales-producer-kpi.md の A-1・「確率」・「出資の回収」）と、架空の入力から手で数えた値。
// golden は目標額を持たない。目標に依る値（差・達成率・届く確率・候補の確率・逆算）は、ここで実行時に作る不規則な桁の目標額で、
// 生成スクリプトの正確な分数の計算と照らす（確率は bp で ±1 まで）。境界の値（ちょうど0・ちょうど半分・端数）も生成スクリプトの計算から取り、実装から写さない。
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {normalizeCompareRequest, normalizeScenarioFacts, MARKET_ASSUMPTIONS, MAX_DEAL_YEN, ScenarioInputError} from '../src/revenue/scenario/scenario-inputs.mjs';
import {compareScenarios, computeScenario, checkedDistribution, scenarioAssumptions, scenarioActions, investmentRecovery, TORNADO_KEYS, GRID_YEN,
  DistributionLimitError} from '../src/revenue/scenario/scenario-model.mjs';
import {rateChain, gridIndex, ratioBps} from '../src/revenue/scenario/money-scenario.mjs';
import {buildExpected, exactScenario, reachBps, quantileYen, candidateDeltas, creators as goldenCreators, sourceActuals as goldenActuals,
  investmentRows as goldenInvestment, scenarioAssumptions as goldenAssumptions, scenarioActions as goldenActions} from './fixtures/scenario/build-expected.mjs';

const fixturePath = fileURLToPath(new URL('./fixtures/scenario/compare-request.json', import.meta.url));
const expectedPath = fileURLToPath(new URL('./fixtures/scenario/expected.json', import.meta.url));
const fixtureText = readFileSync(fixturePath, 'utf8');
const fixture = () => JSON.parse(fixtureText);
const golden = JSON.parse(readFileSync(expectedPath, 'utf8'));
const request = (patch = {}) => normalizeCompareRequest({...fixture().request, ...patch});
const facts = (patch = {}) => normalizeScenarioFacts({...fixture().facts, ...patch});
const run = (patch = {}, factPatch = {}) => compareScenarios(request(patch), facts(factPatch));
const runFixture = (fx) => compareScenarios(normalizeCompareRequest(fx.request), normalizeScenarioFacts(fx.facts));
const exactOf = (fx, key = 'standard') => exactScenario(fx, {assumptions: goldenAssumptions(fx, key), actions: goldenActions(fx, key)});
const pick = (object, keys) => Object.fromEntries(keys.map((key) => [key, object[key]]));
const pickLike = (rows, like) => rows.map((row, i) => pick(row, Object.keys(like[i] ?? row)));
// 分布の平均（応答に出さないので、点から数える。円の端数が出る）
const meanOf = (points) => points.reduce((n, [yen, p]) => n + yen * p, 0);
// 名前が …Yen の値のうち、整数円でも null でもないもの（integrated-money: 金額は整数円）
function nonIntegerYen(value, path = '$', out = []) {
  if (Array.isArray(value)) value.forEach((item, i) => nonIntegerYen(item, `${path}[${i}]`, out));
  else if (value !== null && typeof value === 'object') {
    for (const [key, item] of Object.entries(value)) {
      if (/Yen$/.test(key) && item !== null && typeof item !== 'object' && !Number.isSafeInteger(item)) out.push(`${path}.${key}=${item}`);
      nonIntegerYen(item, `${path}.${key}`, out);
    }
  }
  return out;
}
const field = (fn) => {
  try { fn(); } catch (error) { return error instanceof ScenarioInputError ? error.field : error.message; }
  return null;
};
// 商談1件だけ・行動なし・源泉の実績は接続済みの0件で、分布の形を決めた入力を作る（境界の試験用）
const singleOpportunity = (id, {stageProbabilityBps = {}, ownInvestment = [], committee = []} = {}) => {
  const fx = fixture();
  fx.request.opportunities = fx.request.opportunities.filter((row) => row.id === id);
  fx.request.stageProbabilityBps = {...fx.request.stageProbabilityBps, ...stageProbabilityBps};
  fx.request.actions = [];
  delete fx.request.custom;
  fx.facts = {...fx.facts, ownInvestment, committee, acquisition: [], consignment: []};
  return fx;
};

// 実行時に作る架空の目標額（不規則な桁。fixture・golden には持たない）
const runtimeTargets = () => {
  const s = golden.scenarios.standard;
  return [s.quantiles.p10Yen - 6789, s.quantiles.p50Yen + 12345, s.expectedYen + 1234567, s.quantiles.p90Yen + 1, s.quantiles.p90Yen];
};

test('golden は同じ入力から作り直すと同じ値になり、架空の印があって目標額を持たない', () => {
  assert.deepEqual(buildExpected(fixture()), golden);
  assert.equal(fixture().fictional, true);
  assert.equal(golden.fictional, true);
  assert.equal(Object.hasOwn(fixture().request, 'targets'), false);
  assert.doesNotMatch(JSON.stringify(golden), /"target|"self|"company|salary|rent|compensation/i);
});

test('源泉ごとの実績（粗利と会社の売上）・除外・作り手へ渡る額・行動の実績が golden と一致する', () => {
  const out = run();
  assert.deepEqual(pickLike(out.sources, golden.sources), golden.sources);
  assert.deepEqual(out.excluded, golden.excluded);
  assert.deepEqual(out.creators, golden.creators);
  assert.deepEqual(out.actionActuals, golden.actionActuals);
  assert.equal(out.overlapCount, golden.overlapCount);
  assert.deepEqual(out.unlinkedReports, golden.unlinkedReports);
  assert.deepEqual(pick(out.sources.find((row) => row.source === 'contract_work'), ['status', 'actualYen', 'actualSalesYen']), {status: 'unconnected', actualYen: null, actualSalesYen: null});
});

test('4つのシナリオの内訳・分位点・入金の時期・出資の回収が golden と一致し、分布は bp で ±1 に収まる', () => {
  const out = run();
  assert.deepEqual(Object.keys(out.scenarios), Object.keys(golden.scenarios));
  for (const [key, g] of Object.entries(golden.scenarios)) {
    const s = out.scenarios[key];
    for (const name of ['assumptions', 'actions', 'expectedYen', 'actualYen', 'weightedYen', 'actionYen', 'actualPlusWeightedYen',
      'expectedSalesYen', 'actualSalesYen', 'weightedSalesYen', 'actionSalesYen', 'actualPlusWeightedSalesYen', 'nextPeriodProfitYen',
      'componentCount', 'quantiles', 'quantilesWithoutActions', 'cash']) assert.deepEqual(s[name], g[name], `${key}.${name}`);
    assert.deepEqual(pickLike(s.bySource, g.bySource), g.bySource, `${key}.bySource`);
    assert.deepEqual(pickLike(s.opportunities, g.opportunities), g.opportunities, `${key}.opportunities`);
    assert.deepEqual(pickLike(s.actionRows, g.actionRows), g.actionRows, `${key}.actionRows`);
    const recovery = s.investmentRecovery;
    assert.deepEqual({rows: pickLike(recovery.rows, g.investmentRecovery.rows), total: recovery.total, unknown: recovery.unknown, unconnected: recovery.unconnected},
      g.investmentRecovery, `${key}.investmentRecovery`);
    assert.deepEqual(s.distribution.points.map(([yen]) => yen), g.distribution.points.map(([yen]) => yen), `${key} の分布の点`);
    for (const [i, [yen, p]] of s.distribution.points.entries()) {
      assert.ok(Math.abs(p * 10000 - g.distribution.points[i][1] * 10000) <= 1, `${key} ${yen}円の確率が bp で ±1 を超えた`);
    }
  }
});

test('前提の効きと行動の候補の期待値が golden と一致する', () => {
  const out = run();
  assert.deepEqual(out.tornado.map((row) => pick(row, ['key', 'pessimistic', 'optimistic', 'swingYen', 'cashSwingYen'])), golden.tornado);
  assert.deepEqual(out.tornado.map((row) => row.check !== null), out.tornado.map((_, i) => i < 3));
  assert.deepEqual(out.candidates, golden.candidates);
});

test('KPI の期待値は内訳（実績・確度加重・行動からの見込）を整数にした和で、稼ぎ方別の合計と同じ値（配らない）。会社の売上も同じ', () => {
  const out = run();
  for (const [key, s] of Object.entries(out.scenarios)) {
    for (const row of s.bySource) {
      if (row.expectedYen !== null) assert.equal(row.expectedYen, (row.actualYen ?? 0) + row.weightedYen + row.actionYen, `${key} ${row.source}`);
      if (row.expectedSalesYen !== null) assert.equal(row.expectedSalesYen, (row.actualSalesYen ?? 0) + row.weightedSalesYen + row.actionSalesYen, `${key} ${row.source} の売上`);
    }
    assert.equal(s.expectedYen, s.bySource.reduce((n, row) => n + (row.expectedYen ?? 0), 0));
    assert.equal(s.expectedYen, s.actualYen + s.weightedYen + s.actionYen);
    assert.equal(s.expectedSalesYen, s.bySource.reduce((n, row) => n + (row.expectedSalesYen ?? 0), 0));
    assert.equal(s.expectedSalesYen, s.actualSalesYen + s.weightedSalesYen + s.actionSalesYen);
    assert.equal(s.weightedYen, s.opportunities.filter((row) => row.placement === 'in_period').reduce((n, row) => n + row.weightedYen, 0));
    assert.equal(s.weightedSalesYen, s.opportunities.filter((row) => row.placement === 'in_period').reduce((n, row) => n + row.weightedSalesYen, 0));
    assert.equal(s.actionYen, s.actionRows.reduce((n, row) => n + row.expectedYen, 0));
    assert.equal(s.actionSalesYen, s.actionRows.reduce((n, row) => n + row.expectedSalesYen, 0));
    // 分布の平均と整数の期待値の差は「内訳の数 × 5,001円」以内
    assert.ok(Math.abs(meanOf(s.distribution.points) - s.expectedYen) <= s.componentCount * 5001, `${key} の分布の平均が期待値から離れすぎ`);
  }
  const standard = out.scenarios.standard;
  assert.equal(standard.expectedYen, exactOf(fixture()).expectedYen);
  assert.equal(standard.expectedYen, 13906573);
  // 受託は実績が未接続（null）でも、行動の見込だけは数える
  assert.deepEqual(pick(standard.bySource[0], ['source', 'actualYen', 'actionYen', 'expectedYen', 'actualSalesYen', 'expectedSalesYen']),
    {source: 'contract_work', actualYen: null, actionYen: 750000, expectedYen: 750000, actualSalesYen: null, expectedSalesYen: 750000});
});

test('会社の売上: 買付は窓口の売上（総額）で換算率を掛けず、受託・委託は純額、出資は回収・取得額（申し送り §稼ぎ方ごとの表）', () => {
  const s = run().scenarios.standard;
  const opp = (id) => s.opportunities.find((row) => row.opportunityId === id);
  // MG つきの買付（商談10）: 粗利は残り10万円×手数料率20%＝2万円、売上は窓口の売上の10万円
  assert.deepEqual(pick(opp(10), ['remainingYen', 'valueYen', 'salesValueYen', 'weightedSalesYen']), {remainingYen: 100000, valueYen: 20000, salesValueYen: 100000, weightedSalesYen: 100000});
  // 委託（商談4）は手数料が売上（純額。J-11a (b)）: 192.5万円×20%＝38.5万円、確度0.5で19.25万円
  assert.deepEqual(pick(opp(4), ['valueYen', 'salesValueYen', 'weightedSalesYen']), {valueYen: 385000, salesValueYen: 385000, weightedSalesYen: 192500});
  const action = (source) => s.actionRows.find((row) => row.source === source);
  // 買付の面談1.5件: 売上は 1.5×600万円×0.5×0.3＝135万円、粗利はその換算率30%の40.5万円。1件の額も応答に出す
  assert.deepEqual(pick(action('acquisition'), ['dealYen', 'expectedSalesYen', 'expectedYen', 'salesValueYen', 'valueYen']),
    {dealYen: 6000000, expectedSalesYen: 1350000, expectedYen: 405000, salesValueYen: 6000000, valueYen: 1800000});
  // 受託の提案1件: 売上も粗利も受託費（総製作費2,500万円×受託費率10%）×0.3（純額。J-14 (a)）
  assert.deepEqual(pick(action('contract_work'), ['dealYen', 'expectedSalesYen', 'expectedYen']), {dealYen: 25000000, expectedSalesYen: 750000, expectedYen: 750000});
  // 実績の売上: 自社出資は期間内の入金、委員会は自社の取得額（額の確定した行だけ。107 は除く）、買付は窓口の売上、委託は手数料
  const fx = fixture().facts;
  const sources = Object.fromEntries(run().sources.map((row) => [row.source, row.actualSalesYen]));
  assert.equal(sources.own_investment, fx.ownInvestment[0].receiptsPeriodYen);
  assert.equal(sources.committee, fx.committee.filter((row) => row.acquisitionsPeriodYen !== null).reduce((n, row) => n + row.acquisitionsPeriodYen, 0));
  assert.equal(sources.acquisition, fx.acquisition.filter((row) => row.kind === 'outright' || row.agencyFeePeriodYen !== null).reduce((n, row) => n + row.salesPeriodYen, 0));
  assert.equal(sources.consignment, fx.consignment[0].agencyFeePeriodYen);
});

// 計画の決定（J-11b (a) 払った月に引く。段A の扱い）: 段A は自社出資の払込と買い切りの買付の支払いの月を持たないので、どちらも期間より前に払った（実績の側）とみなし、
// 期間の粗利と期待値から引かない。出資額は出資の回収の累計の差額にだけ出る。委員会の自社の払込は払った日があるので、期間内の分をその月に引く
test('D1: 自社出資の出資額と買い切りの買付額は期間より前に払った扱いで期間の粗利・期待値から引かず、期間内の委員会の自社の払込はその分だけ引く', () => {
  const fx = fixture();
  const base = runFixture(fx);
  const source = (out, key) => out.sources.find((row) => row.source === key);
  const add = (rows, take) => rows.reduce((n, row) => n + take(row), 0);
  // 自社出資の実績は期間内の入金（税込）そのもの（出資額 400万円を引かない）。買い切りの実績は期間内の税抜売上そのもの（買付額 120万円・48万円を引かない）
  const own = fx.facts.ownInvestment[0];
  assert.deepEqual(pick(source(base, 'own_investment'), ['actualYen', 'actualSalesYen', 'rowCount', 'unknownCount']),
    {actualYen: own.receiptsPeriodYen, actualSalesYen: own.receiptsPeriodYen, rowCount: 1, unknownCount: 0});
  const outright = fx.facts.acquisition.filter((row) => row.kind === 'outright');
  const mg = fx.facts.acquisition.filter((row) => row.kind === 'mg');
  assert.equal(source(base, 'acquisition').actualYen, add(outright, (row) => row.salesPeriodYen) + add(mg, (row) => row.agencyFeePeriodYen));
  assert.equal(source(base, 'acquisition').actualYen, 1850000 + 640000 + 420000);

  // 出資額と買付額を増やしても、どのシナリオの期待値・実績・分位点も動かない。出資の回収の累計の差額だけが同じ額動き、期間内の出資は0円のまま
  const raised = fixture();
  raised.facts.ownInvestment[0].investmentYen += 23456789;
  raised.facts.acquisition = raised.facts.acquisition.map((row) => (row.kind === 'outright' ? {...row, purchaseYen: row.purchaseYen + 3456789} : row));
  const after = runFixture(raised);
  const keys = ['expectedYen', 'actualYen', 'expectedSalesYen', 'quantiles', 'quantilesWithoutActions'];
  for (const key of Object.keys(base.scenarios)) assert.deepEqual(pick(after.scenarios[key], keys), pick(base.scenarios[key], keys), key);
  assert.deepEqual(after.sources, base.sources);
  const w103 = (out) => out.scenarios.standard.investmentRecovery.rows.find((row) => row.workId === 103);
  assert.deepEqual([w103(after).investmentYen, w103(after).diffYen], [w103(base).investmentYen + 23456789, w103(base).diffYen - 23456789]);
  assert.deepEqual([w103(base).periodInvestmentYen, w103(after).periodInvestmentYen], [0, 0]);
  assert.equal(base.notes.some((note) => note.code === 'investment_paid_before_period' && /期間より前に払った扱い/.test(note.text)), true);
  // 締めた月より後の日付の委員会の払込は facts に入らない（scenario-facts-model）。そのことを注記で知らせる
  assert.match(base.notes.find((note) => note.code === 'investment_paid_before_period').text, /締めた月より後の日付の払込は、期間内でも期間の粗利・期待値から引かず、出資の回収の累計にも入れていません/);

  // 期間内の委員会の自社の払込は、その月に引く。取得額を上回れば委員会の実績は負のまま足す（0円で止めない）。期待値は生成スクリプトと同じ
  const paid = fixture();
  const extra = 5234567;
  paid.facts.committee = paid.facts.committee.map((row) => (row.workId === 105 ? {...row, paymentsTotalYen: row.paymentsTotalYen + extra, paymentsPeriodYen: row.paymentsPeriodYen + extra} : row));
  const paidOut = runFixture(paid);
  assert.equal(source(paidOut, 'committee').actualYen, source(base, 'committee').actualYen - extra);
  assert.ok(source(paidOut, 'committee').actualYen < 0);
  for (const key of Object.keys(base.scenarios)) {
    assert.equal(paidOut.scenarios[key].expectedYen, base.scenarios[key].expectedYen - extra, key);
    assert.equal(paidOut.scenarios[key].expectedYen, exactOf(paid, key).expectedYen, key);
    assert.ok(paidOut.scenarios[key].bySource.find((row) => row.source === 'committee').expectedYen < 0, `${key} の負の内訳を落とさない`);
  }
  // 期間の前に払った委員会の払込（累計だけ）は、期間の粗利から引かず、出資の回収の差額にだけ出る
  const earlier = fixture();
  earlier.facts.committee = earlier.facts.committee.map((row) => (row.workId === 105 ? {...row, paymentsTotalYen: row.paymentsTotalYen + extra} : row));
  const earlierOut = runFixture(earlier);
  assert.equal(earlierOut.scenarios.standard.expectedYen, base.scenarios.standard.expectedYen);
  const w105 = (out) => out.scenarios.standard.investmentRecovery.rows.find((row) => row.workId === 105);
  assert.equal(w105(earlierOut).diffYen, w105(base).diffYen - extra);

  // 買い切りの行は買付額のある作品だけ（買付額も MG も無い作品は買付に入れない）。買付額の無い買い切りの行は記録の側の誤り
  const broken = fixture().facts;
  broken.acquisition = broken.acquisition.map((row) => (row.workId === 109 ? {...row, purchaseYen: null} : row));
  assert.equal(field(() => normalizeScenarioFacts(broken)), 'facts.acquisition[2].purchaseYen');
});

test('won が2件ある同じ作品×取引先は、ID の順でなく close_date 順に売上を充て、余りを次へ回し、換算率の前に引く', () => {
  const rows = run().scenarios.standard.opportunities;
  const later = rows.find((row) => row.opportunityId === 1), earlier = rows.find((row) => row.opportunityId === 2);
  // 7月以降の売上 450万円（7月150万円・8月300万円）を、ID の大きい商談2（close_date 7/3・400万円）へ先に400万円充て、余りの50万円を商談1（7/20・300万円）へ回す
  // （ID 順に充てると商談1が0円・商談2が250万円残りになる。別の取引先 F への7月の50万円は同じ作品でも取引先が違うので充てない）
  assert.deepEqual(pick(earlier, ['remainingYen', 'valueYen', 'probabilityBps']), {remainingYen: 0, valueYen: 0, probabilityBps: 10000});
  assert.deepEqual(pick(later, ['remainingYen', 'valueYen', 'weightedYen', 'overdue', 'revenueMonth']),
    {remainingYen: 2500000, valueYen: 500000, weightedYen: 500000, overdue: true, revenueMonth: '2026-09'});
  // 確度は段階の表（0.3・0.5・0.8）。失注・源泉の指定が無い・見込額が無い商談は期待値に入れず件数と額を横に出す
  assert.deepEqual(rows.filter((row) => row.stage !== 'won' && row.placement === 'in_period').map((row) => [row.opportunityId, row.probabilityBps]), [[3, 3000], [4, 5000], [5, 8000], [11, 3000]]);
  assert.deepEqual(run().excluded.filter((row) => row.count).map((row) => [row.reason, row.count, row.amountYen]),
    [['lost', 1, 900000], ['no_source', 1, 600000], ['no_amount', 1, 0]]);
  // 38.5万円・112.5万円はちょうど格子の半分（下の試験で half_up を確かめる）
  assert.deepEqual([4, 5].map((id) => rows.find((row) => row.opportunityId === id).valueYen), [385000, 1125000]);
});

test('境界: 端数は2段の truncate、負の月の売上は充てない、期間の前の won は契約に数えない、差額ちょうど0は回収済み', () => {
  const out = run();
  const s = out.scenarios.standard;
  const opp = (id) => s.opportunities.find((row) => row.opportunityId === id);
  // 商談11: 123万4,567円×20%＝24万6,913.4円 → 24万6,913円、確度0.3を掛けて 7万4,073.9円 → 7万4,073円
  // （率を1回で掛けると 7万4,074円、四捨五入でも 7万4,074円になる。golden は生成スクリプトの分数の計算）
  const g11 = golden.scenarios.standard.opportunities.find((row) => row.opportunityId === 11);
  assert.deepEqual(pick(opp(11), ['valueYen', 'weightedYen', 'inflowYen']), pick(g11, ['valueYen', 'weightedYen', 'inflowYen']));
  assert.deepEqual(pick(g11, ['valueYen', 'weightedYen']), {valueYen: 246913, weightedYen: 74073});
  // 商談10（作品108×取引先16）: 5月の240万円を充てて10万円残る。6月の −30万円は充てない（充てると40万円残る）
  assert.equal(golden.scenarios.standard.opportunities.find((row) => row.opportunityId === 10).remainingYen, 100000);
  assert.equal(opp(10).remainingYen, 100000);
  // 商談10は won でも close_date（2026-03-15）が期間（2026-04〜）の前なので、行動の実績の契約に数えない
  assert.deepEqual(out.actionActuals, golden.actionActuals);
  assert.equal(out.actionActuals.bySource.find((row) => row.source === 'acquisition').contract, 0);
  assert.equal(out.actionActuals.total.contract, 2);
  // 差額ちょうど0の委員会111は回収済み（回収待ちではない）。回収率は100%
  assert.deepEqual(pick(s.investmentRecovery.rows.find((row) => row.workId === 111), ['diffYen', 'status', 'recoveryRateBps']), {diffYen: 0, status: 'recovered', recoveryRateBps: 10000});
});

test('作り手・権利元へ渡る額（第4枚）は販売委託の holderAmount の和で、ほかの源泉は null、買付の MG は別列', () => {
  const out = run();
  const holder = fixture().facts.consignment.reduce((n, row) => n + row.holderAmountPeriodYen, 0);
  assert.equal(out.creators.totalYen, holder);
  assert.deepEqual(out.creators.bySource, {contract_work: null, own_investment: null, committee: null, acquisition: null, consignment: holder});
  assert.equal(out.creators.mgReferenceYen, 1000000);
});

test('委託の面談を4件足すと、期待値が 4×0.5×0.3×1件の粗利（702.5万円×20%）だけ増える', () => {
  const base = run().scenarios.standard.expectedYen;
  const actions = fixture().request.actions.map((row) => (row.source === 'consignment' ? {...row, countX100: row.countX100 + 400} : row));
  assert.equal(run({actions}).scenarios.standard.expectedYen - base, 4 * 0.5 * 0.3 * 1405000);
  // 1件ずつの候補の増分も同じ式（1×0.5×0.3×140.5万円）。1件の粗利 140.5万円は格子のちょうど半分で、k 件の合計を寄せる（1件を寄せて k 倍しない）
  assert.equal(run().candidates.find((row) => row.source === 'consignment').expectedDeltaYen, 210750);
});

test('入金の遅れを1か月足すと、期末の月の入金が期間の外へ出る。遅れが上限なら外へ出る額は測れない', () => {
  const base = run().scenarios.standard.cash;
  const later = run({assumptions: {...fixture().request.assumptions, paymentDelayMonths: 1}}).scenarios.standard.cash;
  assert.deepEqual(base.byMonth.at(-1), {month: '2027-03', yen: 750000});
  assert.equal(base.slipOutYen, 750000);
  assert.equal(later.periodYen, base.periodYen - base.slipOutYen);
  assert.equal(later.nextPeriodYen, base.nextPeriodYen + base.slipOutYen);
  assert.equal(later.byMonth.some((row) => row.month === '2027-04'), false);
  const max = run({assumptions: {...fixture().request.assumptions, paymentDelayMonths: 6}}).scenarios.standard.cash;
  assert.equal(max.slipOutYen, null);
});

test('目標に依る値（差・達成率・届く確率・候補の確率）を実行時の目標額で数え、正確な分数の計算と bp で ±1 まで一致する', () => {
  const fx = fixture();
  for (const target of runtimeTargets()) {
    const out = run({targets: {selfYen: target}});
    assert.equal(Object.hasOwn(out.targetView, 'company'), false);
    for (const key of Object.keys(golden.scenarios)) {
      const exact = exactOf(fx, key);
      const view = out.targetView.self.scenarios[key];
      assert.ok(Math.abs(view.reachBps - reachBps(exact.dist, target)) <= 1, `${key} ${target}円の届く確率`);
      assert.ok(Math.abs(view.reachWithoutActionsBps - reachBps(exact.withoutActions, target)) <= 1, `${key} ${target}円の案件だけの確率`);
      assert.equal(view.gapYen, golden.scenarios[key].expectedYen - target);
      // 達成率は 期待値÷目標 を bp で切り捨て
      assert.equal(view.achievementBps, Number((BigInt(golden.scenarios[key].expectedYen) * 10000n) / BigInt(target)));
    }
    for (const row of out.targetView.self.candidates) {
      const actions = goldenActions(fx, 'standard').map((a) => (a.source === row.source && a.step === row.step ? {...a, countX100: a.countX100 + 100} : a));
      const after = reachBps(exactScenario(fx, {assumptions: goldenAssumptions(fx, 'standard'), actions}).dist, target);
      assert.ok(Math.abs(row.reachAfterBps - after) <= 1, `${row.source}:${row.step} の候補の確率（${target}円）`);
    }
    assert.deepEqual(out.targetView.self.candidates.map((row) => row.expectedDeltaYen).sort(), candidateDeltas(fx).map((row) => row.expectedDeltaYen).sort());
  }
  // 目標を送らない応答には目標に由来する値が無い
  assert.equal(Object.hasOwn(run(), 'targetView'), false);
});

test('回収待ちを含んで期待値が0以下のときは、負の達成率を出さない（ちょうど0も出さない）', () => {
  const fx = fixture();
  // 期間内に払った委員会の自社の払込（その月に引く）が、取得額を大きく上回る
  fx.facts.committee = fx.facts.committee.map((row) => (row.workId === 105 ? {...row, paymentsTotalYen: 38000000, paymentsPeriodYen: 31000000} : row));
  const expectedYen = exactOf(fx).expectedYen;
  assert.ok(expectedYen < 0);
  const out = compareScenarios(normalizeCompareRequest({...fx.request, targets: {companyYen: 3456789}}), normalizeScenarioFacts(fx.facts));
  assert.equal(out.targetView.company.scenarios.standard.achievementBps, null);
  assert.equal(out.targetView.company.scenarios.standard.gapYen, expectedYen - 3456789);
  assert.equal(out.scenarios.standard.bySource.find((row) => row.source === 'committee').awaitingRecovery, true);
  // 期待値ちょうど0: 委員会の実績 −90万円（期間内の取得額0・期間内の自社の払込90万円）と商談5の確度加重 +90万円（112.5万円×0.8）
  const zero = singleOpportunity(5, {committee: [{workId: 105, title: '雪の灯台（架空）', selfInvested: true, paymentsTotalYen: 900000, paymentsPeriodYen: 900000,
    acquisitionsTotalYen: 0, acquisitionsPeriodYen: 0, error: null, holdNote: null}]});
  assert.equal(exactOf(zero).expectedYen, 0);
  const view = compareScenarios(normalizeCompareRequest({...zero.request, targets: {selfYen: 2345671}}), normalizeScenarioFacts(zero.facts));
  assert.equal(view.scenarios.standard.expectedYen, 0);
  assert.deepEqual(pick(view.targetView.self.scenarios.standard, ['gapYen', 'achievementBps']), {gapYen: -2345671, achievementBps: null});
});

test('逆算はいまの行動をそろって0.05倍刻みで増やし、期待値で届く最小の倍率と確率70%に届く最小の倍率を返す', () => {
  const fx = fixture();
  const target = golden.scenarios.standard.expectedYen + 2345678;
  const view = run({targets: {selfYen: target}}).targetView.self.reverse;
  // 正確な計算で同じ倍率を探す
  const scaled = (m) => goldenActions(fx, 'standard').map((a) => ({...a, countX100: Math.trunc((a.countX100 * m) / 100)}));
  let expectedAt = null, probabilityAt = null;
  for (let m = 100; m <= 400 && (expectedAt === null || probabilityAt === null); m += 5) {
    const exact = exactScenario(fx, {assumptions: goldenAssumptions(fx, 'standard'), actions: scaled(m)});
    if (expectedAt === null && exact.expectedYen >= target) expectedAt = m;
    if (probabilityAt === null && reachBps(exact.dist, target) >= 7000) probabilityAt = m;
  }
  assert.equal(view.expected?.multiplierX100 ?? null, expectedAt);
  assert.equal(view.probability?.multiplierX100 ?? null, probabilityAt);
  assert.ok(expectedAt !== null && probabilityAt !== null, '架空の入力で両方の倍率が見つかる');
  assert.deepEqual(view.fixed, []);
  // 時間は増やした件数×1件の時間
  assert.equal(view.expected.hoursX100, scaled(expectedAt).reduce((n, a) => n + Math.trunc((a.countX100 * a.hoursX100) / 100), 0));
});

test('逆算: 1件増やしても期待値が5,000円以内しか動かない行動は理由（flat）つきで固定し、5,001円動く行動は増やす', () => {
  const fx = fixture();
  // 委員会の面談: 3万3,334円×0.5×0.3＝5,000.1円 → 1件で5,000円（固定）。自社出資の面談: 3万3,341円×0.15＝5,001.15円 → 5,001円（固定しない）
  fx.request.actions = [...fx.request.actions,
    {source: 'committee', step: 'meeting', countX100: 100, dealYen: 33334, conversionBps: 10000, hoursX100: 300},
    {source: 'own_investment', step: 'meeting', countX100: 100, dealYen: 33341, conversionBps: 10000, hoursX100: 300}];
  delete fx.request.custom;
  const deltas = new Map(candidateDeltas(fx).map((row) => [`${row.source}:${row.step}`, row.expectedDeltaYen]));
  assert.deepEqual([deltas.get('committee:meeting'), deltas.get('own_investment:meeting')], [5000, 5001]);
  const target = exactOf(fx).expectedYen + 3456789;
  const view = compareScenarios(normalizeCompareRequest({...fx.request, targets: {selfYen: target}}), normalizeScenarioFacts(fx.facts)).targetView.self.reverse;
  assert.deepEqual(view.fixed, [{source: 'committee', step: 'meeting', reason: 'flat'}]);
  // 固定した行動はそのままで、残りをそろって増やした正確な計算と同じ倍率
  const scaled = (m) => goldenActions(fx, 'standard').map((a) => (a.source === 'committee' ? a : {...a, countX100: Math.trunc((a.countX100 * m) / 100)}));
  let expectedAt = null, probabilityAt = null;
  for (let m = 100; m <= 400 && (expectedAt === null || probabilityAt === null); m += 5) {
    const exact = exactScenario(fx, {assumptions: goldenAssumptions(fx, 'standard'), actions: scaled(m)});
    if (expectedAt === null && exact.expectedYen >= target) expectedAt = m;
    if (probabilityAt === null && reachBps(exact.dist, target) >= 7000) probabilityAt = m;
  }
  assert.ok(expectedAt !== null && probabilityAt !== null);
  assert.equal(view.expected.multiplierX100, expectedAt);
  assert.equal(view.probability.multiplierX100, probabilityAt);
  assert.equal(view.expected.actions.find((row) => row.source === 'committee').countX100, 100);
});

test('行動の候補の並び: 増分÷時間が同じなら期待値の増分の大きい順、時間0どうしは増分の順（申し送り K-e）', () => {
  const fx = fixture();
  // 自社出資の面談: 281万円×0.15＝42万1,500円を6時間（1時間 7万250円）。委託の面談 21万750円を3時間と同じ率で、増分が大きいので先
  // 時間0の2つ: 委員会の面談（200万円×0.15＝30万円）を受託の提案（75万円）より前に置いても、増分の大きい受託が先
  fx.request.actions = [
    {source: 'committee', step: 'meeting', countX100: 100, dealYen: 2000000, conversionBps: 10000, hoursX100: 0},
    ...fx.request.actions.map((row) => (row.source === 'contract_work' ? {...row, hoursX100: 0} : row)),
    {source: 'own_investment', step: 'meeting', countX100: 100, dealYen: 2810000, conversionBps: 10000, hoursX100: 600},
  ];
  delete fx.request.custom;
  const order = runFixture(fx).candidates.map((row) => `${row.source}:${row.step}`);
  assert.deepEqual(order, candidateDeltas(fx).map((row) => `${row.source}:${row.step}`));
  assert.deepEqual(order, ['contract_work:proposal', 'committee:meeting', 'acquisition:meeting', 'own_investment:meeting', 'consignment:meeting']);
  // 届く確率の増分で並べるときも、時間0どうしは確率の増分の順（期待値の増分の順ではない）。
  // 委員会の面談（400万円・成立0.15。期待値 +60万円）と自社出資の提案（100万円・成立0.3。+30万円）を時間0で足し、目標を期待値より下に置くと、
  // 小さく成立しやすい自社出資の提案のほうが届く確率を大きく上げる
  const zero = fixture();
  zero.request.actions = [...zero.request.actions,
    {source: 'committee', step: 'meeting', countX100: 0, dealYen: 4000000, conversionBps: 10000, hoursX100: 0},
    {source: 'own_investment', step: 'proposal', countX100: 0, dealYen: 1000000, conversionBps: 10000, hoursX100: 0}];
  delete zero.request.custom;
  const target = 11963457;
  const exactReach = (source) => {
    const actions = goldenActions(zero, 'standard').map((a) => (a.source === source && a.hoursX100 === 0 ? {...a, countX100: 100} : a));
    return reachBps(exactScenario(zero, {assumptions: goldenAssumptions(zero, 'standard'), actions}).dist, target);
  };
  assert.ok(exactReach('own_investment') - exactReach('committee') >= 100, '正確な計算で自社出資の提案の確率の増分がはっきり大きい');
  const view = compareScenarios(normalizeCompareRequest({...zero.request, targets: {selfYen: target}}), normalizeScenarioFacts(zero.facts)).targetView.self.candidates;
  assert.deepEqual(view.slice(0, 2).map((row) => [`${row.source}:${row.step}`, row.expectedDeltaYen]), [['own_investment:proposal', 300000], ['committee:meeting', 600000]]);
});

test('楽観・悲観は確率・分位点・期待値が 悲観 ≤ 標準 ≤ 楽観 の順に並ぶ', () => {
  const targets = runtimeTargets();
  const out = run({targets: {selfYen: targets[1], companyYen: targets[2]}});
  const {standard, optimistic, pessimistic} = out.scenarios;
  assert.ok(pessimistic.expectedYen <= standard.expectedYen && standard.expectedYen <= optimistic.expectedYen);
  for (const q of ['p10Yen', 'p50Yen', 'p90Yen']) assert.ok(pessimistic.quantiles[q] <= standard.quantiles[q] && standard.quantiles[q] <= optimistic.quantiles[q], q);
  for (const name of ['self', 'company']) {
    const v = out.targetView[name].scenarios;
    assert.ok(v.pessimistic.reachBps <= v.standard.reachBps && v.standard.reachBps <= v.optimistic.reachBps, name);
  }
  // 実行時の目標を細かく動かしても順は崩れない（正確な分数で）
  const fx = fixture();
  const [p, s, o] = ['pessimistic', 'standard', 'optimistic'].map((key) => exactOf(fx, key).dist);
  for (let t = quantileYen(p, 1, 100); t <= quantileYen(o, 99, 100); t += 70001) {
    assert.ok(reachBps(p, t) <= reachBps(s, t) && reachBps(s, t) <= reachBps(o, t), `${t}円`);
  }
});

test('分位点は累積が p 以上になる最小の値: ちょうど0.5なら下の値、1−0.9 の浮動小数の誤差でも0.1を下の値で取る', () => {
  // 商談4だけ（確度0.5・38.5万円 → 格子39）: 0円と39万円が半分ずつ。累積がちょうど0.5の0円が50%点
  const half = singleOpportunity(4);
  const exactHalf = exactOf(half).dist;
  const s = runFixture(half).scenarios.standard;
  assert.deepEqual(s.quantiles, {p10Yen: quantileYen(exactHalf, 1, 10), p50Yen: quantileYen(exactHalf, 1, 2), p90Yen: quantileYen(exactHalf, 9, 10)});
  assert.deepEqual(s.quantiles, {p10Yen: 0, p50Yen: 0, p90Yen: 390000});
  // 同じ商談を確度0.9に: 0円の確率は Float64 で 1−0.9＝0.09999… になるが、正確には0.1で、10%点は0円
  const ninety = singleOpportunity(4, {stageProbabilityBps: {proposal: 9000}});
  const exactNinety = exactOf(ninety).dist;
  assert.equal(quantileYen(exactNinety, 1, 10), 0);
  assert.equal(runFixture(ninety).scenarios.standard.quantiles.p10Yen, 0);
});

test('件数が多く成立の確率が高い行動でも、二項分布の確率が潰れず、分位点が正確な計算と一致する。大きすぎる分布は止める', () => {
  const fx = fixture();
  fx.request.assumptions = {...fx.request.assumptions, proposalToContractBps: 9900};
  fx.request.actions = [{source: 'contract_work', step: 'proposal', countX100: 100000, dealYen: 1000000, conversionBps: 10000, hoursX100: 100}];
  delete fx.request.custom;
  const s = runFixture(fx).scenarios.standard;
  const exact = exactOf(fx);
  assert.equal(s.expectedYen, exact.expectedYen);
  // (1−0.99)^1000 は Float64 で0になる。潰れると平均が期待値から大きく離れる（以前は 99.6億円の期待値に対して平均が約600万円）
  assert.ok(Math.abs(meanOf(s.distribution.points) - s.expectedYen) <= s.componentCount * 5001, `平均 ${meanOf(s.distribution.points)} と期待値 ${s.expectedYen}`);
  assert.deepEqual(s.quantiles, {p10Yen: quantileYen(exact.dist, 1, 10), p50Yen: quantileYen(exact.dist, 1, 2), p90Yen: quantileYen(exact.dist, 9, 10)});
  const total = s.distribution.points.reduce((n, [, p]) => n + p, 0);
  assert.ok(Math.abs(total - 1) < 1e-9, `確率の和 ${total}`);
  // 1件の額の上限を超える要求は本文の検証で止め、上限の内でも分布の格子が多すぎる要求は配列を作る前に止める
  const big = {...fx.request.actions[0], dealYen: MAX_DEAL_YEN + 1};
  assert.equal(field(() => normalizeCompareRequest({...fx.request, actions: [big]})), 'actions[0].dealYen');
  const wide = {...fx.request, actions: [{...fx.request.actions[0], dealYen: MAX_DEAL_YEN, countX100: 100000}]};
  assert.equal(field(() => compareScenarios(normalizeCompareRequest(wide), normalizeScenarioFacts(fx.facts))), 'actions');
});

// 5つの稼ぎ方の提案を各10件・1件6,000万円にした架空の要求。標準・楽観・悲観の分布は1本の上限の内だが、目標を付けると逆算の倍率の先で上限に当たる
const heavyFixture = () => {
  const fx = fixture();
  fx.request.actions = ['contract_work', 'own_investment', 'committee', 'acquisition', 'consignment']
    .map((source) => ({source, step: 'proposal', countX100: 1000, dealYen: 60000000, conversionBps: 10000, hoursX100: 100}));
  delete fx.request.custom;
  return fx;
};
const scaledCounts = (fx, m) => fx.request.actions.map((row) => ({...row, countX100: Math.trunc((row.countX100 * m) / 100)}));
// 行動からの見込の和（計画の式: 1件の額×件数×換算率×前提の倍率×提案→契約の率 を行動ごとに1回 truncate）を、model を通さずに足す
const actionExpectedOf = (fx, actions) => actions.reduce((n, act) => {
  const a = fx.request.assumptions;
  const market = act.source === 'acquisition' || act.source === 'consignment' ? [a.salesMultiplierBps]
    : act.source === 'own_investment' || act.source === 'committee' ? [a.recoveryAmountBps] : [];
  const rates = [act.conversionBps, ...market, a.proposalToContractBps];
  const numerator = rates.reduce((x, r) => x * BigInt(r), BigInt(act.dealYen) * BigInt(act.countX100));
  return n + Number(numerator / (100n * 10000n ** BigInt(rates.length)));
}, 0);
const withTargets = (fx, targets) => compareScenarios(normalizeCompareRequest({...fx.request, targets}), normalizeScenarioFacts(fx.facts));

test('逆算は、分布が1本の上限を超える倍率で確率の探索を止めて倍率と理由を返し、応答全体は止めない。期待値で届く倍率は止めたあとも探す', () => {
  const fx = heavyFixture();
  const plain = runFixture(fx);
  const target = 3000004321;
  const out = withTargets(fx, {selfYen: target});
  const reverse = out.targetView.self.reverse;
  assert.equal(reverse.stopped?.reason, 'too_large', JSON.stringify(reverse.stopped));
  const at = reverse.stopped.multiplierX100;
  // 止めた倍率の件数は、カスタムのシナリオにすると1本の上限を超えて要求ごと止まる（400 の側）。その1つ手前の倍率は数えられる
  const customAt = (m) => () => compareScenarios(normalizeCompareRequest({...fx.request, custom: {actions: scaledCounts(fx, m).map(({source, step, countX100}) => ({source, step, countX100}))}}),
    normalizeScenarioFacts(fx.facts));
  assert.throws(customAt(at), (e) => e instanceof DistributionLimitError && e.reason === 'too_large' && e.field === 'actions');
  assert.doesNotThrow(customAt(at - 5));
  // 確率70%の倍率は止めた倍率の手前までに無い。期待値で届く最小の倍率は、止めた倍率より先にあり、計画の式で足した期待値と一致する
  assert.equal(reverse.probability, null);
  const base = runFixture({...fx, request: {...fx.request, actions: []}}).scenarios.standard.expectedYen;
  let expectedAt = null;
  for (let m = 100; m <= 400 && expectedAt === null; m += 5) if (base + actionExpectedOf(fx, scaledCounts(fx, m)) >= target) expectedAt = m;
  assert.ok(expectedAt !== null && expectedAt > at, `期待値の倍率 ${expectedAt}・止めた倍率 ${at}`);
  assert.deepEqual(pick(reverse.expected, ['multiplierX100', 'expectedYen']), {multiplierX100: expectedAt, expectedYen: base + actionExpectedOf(fx, scaledCounts(fx, expectedAt))});
  // 標準・楽観・悲観は目標の無い応答と同じ値で、数えていない所があることを注記で知らせる
  assert.deepEqual(out.scenarios, plain.scenarios);
  assert.equal(out.notes.some((row) => row.code === 'distribution_limit'), true);
  assert.equal(plain.notes.some((row) => row.code === 'distribution_limit'), false);
  assert.deepEqual(out.targetView.self.candidates.map((row) => row.stopped), out.targetView.self.candidates.map(() => null));
});

test('1つの要求で数える分布の合計が上限を超えたら、その先の逆算の確率を止めて理由を返し、先に数えた目標の値は変えない', () => {
  const fx = heavyFixture();
  const target = 3000004321;
  const single = withTargets(fx, {selfYen: target});
  const both = withTargets(fx, {selfYen: target, companyYen: target});
  // 先に数えた自分の目標は、目標が1つのときと同じ（1本の上限で止めた倍率も同じ）
  assert.deepEqual(both.targetView.self, single.targetView.self);
  const company = both.targetView.company;
  // 会社の目標は、要求の合計の上限で、1本の上限より手前の倍率で止まる。期待値の倍率と候補の確率は同じ値
  assert.equal(company.reverse.stopped?.reason, 'request_limit', JSON.stringify(company.reverse.stopped));
  assert.ok(company.reverse.stopped.multiplierX100 < single.targetView.self.reverse.stopped.multiplierX100);
  assert.deepEqual(pick(company.reverse, ['expected', 'probability', 'fixed']), pick(single.targetView.self.reverse, ['expected', 'probability', 'fixed']));
  assert.deepEqual(company.candidates, single.targetView.self.candidates);
  assert.equal(both.notes.filter((row) => row.code === 'distribution_limit').length, 1);
});

test('行動の候補の届く確率は、1件足した分布が1本の上限を超える候補だけ null にして理由を添え、並びの最後に置く', () => {
  // 受託の提案 1件1億円: 199件は1本の上限の内、200件は超える（計画の上限 2,000,000格子・5,000万回の境界）。委託の面談は小さい
  const fx = fixture();
  fx.request.actions = [{source: 'contract_work', step: 'proposal', countX100: 19900, dealYen: 100000000, conversionBps: 10000, hoursX100: 50},
    {source: 'consignment', step: 'meeting', countX100: 400, dealYen: 7025000, conversionBps: 2000, hoursX100: 300}];
  delete fx.request.custom;
  const over = structuredClone(fx);
  over.request.actions[0].countX100 = 20000;
  assert.throws(() => runFixture(over), (e) => e instanceof DistributionLimitError && e.reason === 'too_large');
  const target = runFixture(fx).scenarios.standard.expectedYen + 2345678;
  const out = withTargets(fx, {selfYen: target});
  const view = out.targetView.self;
  // 受託は期待値の増分÷時間の並び（目標に依らない候補）では先頭だが、届く確率を数えられないので目標の候補では最後に置き、確率は null
  assert.deepEqual(out.candidates.map((row) => `${row.source}:${row.step}`), ['contract_work:proposal', 'consignment:meeting']);
  assert.deepEqual(view.candidates.map((row) => [`${row.source}:${row.step}`, row.stopped]), [['consignment:meeting', null], ['contract_work:proposal', 'too_large']]);
  assert.deepEqual(pick(view.candidates[1], ['reachAfterBps', 'reachDeltaBps']), {reachAfterBps: null, reachDeltaBps: null});
  assert.equal(Number.isInteger(view.candidates[0].reachAfterBps), true);
  assert.deepEqual(view.reverse.stopped, {multiplierX100: 105, reason: 'too_large'});
});

test('同じ入力からは同じ出力になり、入力を書き換えない', () => {
  const req = request({targets: {selfYen: runtimeTargets()[1]}});
  const f = facts();
  const before = JSON.stringify([req, f]);
  const a = compareScenarios(req, f);
  const b = compareScenarios(req, f);
  assert.deepEqual(a, b);
  assert.equal(JSON.stringify(a), JSON.stringify(compareScenarios(request({targets: {selfYen: runtimeTargets()[1]}}), facts())));
  assert.equal(JSON.stringify([req, f]), before);
});

test('前提の効きは市場の前提だけで、交渉の条件と作り手の取り分の変数が無く、カスタムでも動かせない', () => {
  const out = run();
  assert.deepEqual([...TORNADO_KEYS].sort(), [...MARKET_ASSUMPTIONS].sort());
  for (const row of out.tornado) {
    assert.ok(MARKET_ASSUMPTIONS.includes(row.key), row.key);
    assert.doesNotMatch(row.key, /conversion|fee|holder|markup|mg|share|creator|commission/i);
  }
  // 楽観・悲観・カスタムでも換算率（交渉の条件）と1件の額は変わらない
  const rates = (s) => s.opportunities.map((row) => row.remainingYen);
  for (const s of Object.values(out.scenarios)) assert.deepEqual(rates(s), rates(out.scenarios.standard));
  const base = fixture().request;
  assert.throws(() => normalizeCompareRequest({...base, custom: {assumptions: {conversionBps: 3000}}}), (e) => e instanceof ScenarioInputError && e.field === 'custom.assumptions.conversionBps');
  assert.throws(() => normalizeCompareRequest({...base, custom: {actions: [{source: 'consignment', step: 'meeting', countX100: 100, conversionBps: 3000}]}}),
    (e) => e instanceof ScenarioInputError && e.field === 'custom.actions[0].conversionBps');
  assert.throws(() => normalizeCompareRequest({...base, custom: {actions: [{source: 'consignment', step: 'meeting', countX100: 100, dealYen: 9000000}]}}),
    (e) => e instanceof ScenarioInputError && e.field === 'custom.actions[0].dealYen');
});

test('出資の回収: 差額＝収益−出資額、負は回収待ち、出資額 0・NULL は回収率 null、合計は差額の分かる行だけで足して算術が合う', () => {
  const {rows, total, unknown, unconnected} = run().scenarios.standard.investmentRecovery;
  const byWork = new Map(rows.map((row) => [row.workId, row]));
  assert.deepEqual(pick(byWork.get(103), ['kind', 'diffYen', 'status', 'recoveryRateBps', 'remainingExpectedYen', 'projectedDiffYen', 'periodInvestmentYen']),
    {kind: 'own_investment', diffYen: -1800000, status: 'awaiting', recoveryRateBps: 5500, remainingExpectedYen: 900000, projectedDiffYen: -900000, periodInvestmentYen: 0});
  // 4,062,000 ÷ 1,800,000 = 2.2566… を bp で切り捨て
  assert.deepEqual(pick(byWork.get(104), ['diffYen', 'status', 'recoveryRateBps']), {diffYen: 2262000, status: 'recovered', recoveryRateBps: 22566});
  assert.deepEqual(pick(byWork.get(105), ['diffYen', 'status', 'recoveryRateBps']), {diffYen: -6500000, status: 'awaiting', recoveryRateBps: 1875});
  assert.deepEqual(pick(byWork.get(106), ['investmentYen', 'diffYen', 'status', 'recoveryRateBps']), {investmentYen: 0, diffYen: 700000, status: 'recovered', recoveryRateBps: null});
  assert.deepEqual(pick(byWork.get(107), ['diffYen', 'status', 'recoveryRateBps', 'error']), {diffYen: null, status: 'unknown', recoveryRateBps: null, error: '委員会契約に条件版がありません'});
  assert.equal(rows.some((row) => !['awaiting', 'recovered', 'unknown'].includes(row.status)), false);
  // 合計は差額の分かる行（107 を除く5行）だけで、どの列も同じ行の集合
  const known = rows.filter((row) => row.diffYen !== null);
  for (const key of ['investmentYen', 'revenueYen', 'diffYen', 'periodInvestmentYen', 'periodRevenueYen', 'projectedDiffYen']) {
    assert.equal(total[key], known.reduce((n, row) => n + row[key], 0), key);
  }
  assert.equal(total.revenueYen - total.investmentYen, total.diffYen, '収益−出資額＝差額');
  assert.equal(total.projectedDiffYen, total.diffYen + known.reduce((n, row) => n + row.remainingExpectedYen, 0));
  // 10,462,000 ÷ 15,800,000 ＝ 0.6621… を切り捨て（回収率も同じ行の集合）
  assert.deepEqual(pick(total, ['rowCount', 'investmentYen', 'revenueYen', 'diffYen', 'recoveryRateBps', 'status']),
    {rowCount: 5, investmentYen: 15800000, revenueYen: 10462000, diffYen: -5338000, recoveryRateBps: 6621, status: 'awaiting'});
  assert.equal(total.recoveryRateBps, ratioBps(total.revenueYen, total.investmentYen));
  // 差額の分からない行（107）は件数と出資額を別に出す
  assert.deepEqual(unknown, {count: 1, investmentYen: 5000000});
  assert.deepEqual(unconnected, []);
  // 出資額が NULL の行も回収率は null（0% で埋めない）。合計に入る行が無ければ回収済みと言わない
  const onlyUnknown = investmentRecovery({ownInvestment: [{workId: 1, title: '架空', investmentYen: null, receiptsTotalYen: 5000, receiptsPeriodYen: 0}], committee: []});
  assert.deepEqual(pick(onlyUnknown.rows[0], ['diffYen', 'recoveryRateBps', 'status']), {diffYen: null, recoveryRateBps: null, status: 'unknown'});
  assert.deepEqual(pick(onlyUnknown.total, ['rowCount', 'investmentYen', 'diffYen', 'recoveryRateBps', 'status']), {rowCount: 0, investmentYen: null, diffYen: null, recoveryRateBps: null, status: 'unknown'});
  assert.deepEqual(onlyUnknown.unknown, {count: 1, investmentYen: null});
  // 差額の分かる行で期間内の収益だけが無いときは、その列の合計を null にする（一部だけ足した値を出さない）
  const partialFacts = {ownInvestment: [], committee: [
    {workId: 2, title: '架空A', selfInvested: true, paymentsTotalYen: 100, paymentsPeriodYen: 0, acquisitionsTotalYen: 300, acquisitionsPeriodYen: null, error: null, holdNote: null},
    {workId: 3, title: '架空B', selfInvested: true, paymentsTotalYen: 200, paymentsPeriodYen: 0, acquisitionsTotalYen: 100, acquisitionsPeriodYen: 50, error: null, holdNote: null}]};
  const partial = investmentRecovery(partialFacts);
  assert.deepEqual(pick(partial.total, ['diffYen', 'periodRevenueYen', 'status']), {diffYen: 100, periodRevenueYen: null, status: 'recovered'});
  assert.deepEqual(partial, goldenInvestment(partialFacts, []));
});

test('出資の回収: 自社の出資の無い委員会の作品（selfInvested が false）は行にも合計にも入れず、源泉3の実績には入れる', () => {
  const fx = fixture();
  const before = runFixture(fx);
  // 自社が参加者でない委員会の作品: 払込0円で、窓口・幹事の手数料の取り分だけの取得額 32万円が期間内に立つ
  fx.facts.committee.push({workId: 112, title: '霧の渡し船（架空）', selfInvested: false, paymentsTotalYen: 0, paymentsPeriodYen: 0,
    acquisitionsTotalYen: 320000, acquisitionsPeriodYen: 320000, error: null, holdNote: null});
  const after = runFixture(fx);
  const recovery = (out) => out.scenarios.standard.investmentRecovery;
  assert.equal(recovery(after).rows.some((row) => row.workId === 112), false, '出資額0円で回収済みの行にしない');
  assert.deepEqual({rows: recovery(after).rows, total: recovery(after).total, unknown: recovery(after).unknown}, {rows: recovery(before).rows, total: recovery(before).total, unknown: recovery(before).unknown});
  const committee = (out) => out.sources.find((row) => row.source === 'committee');
  assert.deepEqual([committee(after).actualYen, committee(after).rowCount], [committee(before).actualYen + 320000, committee(before).rowCount + 1]);
  // 本文の形: selfInvested は true か false で、無い・違う型の行は記録の側の誤りとして止める
  const row = {...fixture().facts.committee[0]};
  delete row.selfInvested;
  assert.equal(field(() => normalizeScenarioFacts({...fixture().facts, committee: [row]})), 'facts.committee[0].selfInvested');
  assert.equal(field(() => normalizeScenarioFacts({...fixture().facts, committee: [{...row, selfInvested: 1}]})), 'facts.committee[0].selfInvested');
});

test('買付・販売委託の契約にも入る委員会の作品（overlap）は源泉3の実績に入れず未確定に数え、期待値も golden の生成スクリプトと同じ。出資の回収の行は変えない', () => {
  const fx = fixture();
  const before = runFixture(fx);
  fx.facts.committee = fx.facts.committee.map((row) => (row.workId === 104 ? {...row, overlap: true} : row));
  const after = runFixture(fx);
  const committee = (out) => out.sources.find((row) => row.source === 'committee');
  const w104 = fixture().facts.committee.find((row) => row.workId === 104);
  assert.deepEqual([committee(after).actualYen, committee(after).actualSalesYen, committee(after).rowCount, committee(after).unknownCount],
    [committee(before).actualYen - (w104.acquisitionsPeriodYen - w104.paymentsPeriodYen), committee(before).actualSalesYen - w104.acquisitionsPeriodYen, committee(before).rowCount - 1, committee(before).unknownCount + 1]);
  assert.deepEqual(pick(committee(after), ['status', 'actualYen', 'actualSalesYen', 'rowCount', 'unknownCount']), goldenActuals(fx.facts).committee);
  assert.equal(after.scenarios.standard.expectedYen, exactOf(fx).expectedYen);
  assert.deepEqual(after.scenarios.standard.investmentRecovery, before.scenarios.standard.investmentRecovery);
  assert.equal(before.notes.some((note) => note.code === 'overlap_committee'), false);
  assert.match(after.notes.find((note) => note.code === 'overlap_committee').text, /製作委員会の作品 1件は、取得額を契約の分と分けられない/);
  // 本文の形: overlap は無いか true・false。違う型は記録の側の誤りとして止める
  assert.equal(field(() => normalizeScenarioFacts({...fixture().facts, committee: [{...fixture().facts.committee[0], overlap: 1}]})), 'facts.committee[0].overlap');
});

test('実績の源泉が null（未接続）なら 0円で埋めず、作り手へ渡る額と出資の回収の合計も null。空の配列は0円の接続済み、全部未確定は unknown', () => {
  const fx = fixture();
  const nulls = {...fx.facts, ownInvestment: null, committee: null, acquisition: null, consignment: null};
  const out = compareScenarios(request(), normalizeScenarioFacts(nulls));
  const expectedSources = goldenActuals(nulls);
  for (const row of out.sources) {
    assert.deepEqual(pick(row, ['status', 'actualYen', 'actualSalesYen', 'rowCount', 'unknownCount']), expectedSources[row.source], row.source);
    assert.deepEqual(pick(row, ['status', 'actualYen', 'actualSalesYen']), {status: 'unconnected', actualYen: null, actualSalesYen: null}, row.source);
  }
  assert.deepEqual(out.creators, goldenCreators(nulls));
  assert.deepEqual(out.creators, {totalYen: null, bySource: {contract_work: null, own_investment: null, committee: null, acquisition: null, consignment: null}, mgReferenceYen: null});
  const recovery = out.scenarios.standard.investmentRecovery;
  assert.deepEqual(recovery, goldenInvestment(nulls, []));
  assert.deepEqual(recovery.rows, []);
  assert.deepEqual(pick(recovery.total, ['investmentYen', 'revenueYen', 'diffYen', 'recoveryRateBps', 'status']), {investmentYen: null, revenueYen: null, diffYen: null, recoveryRateBps: null, status: 'unconnected'});
  assert.deepEqual(recovery.unconnected, ['own_investment', 'committee']);
  // 実績が未接続でも商談の見込（商談5の確度加重）は数え、実績は null のまま。期待値は golden の計算と同じ
  const own = out.scenarios.standard.bySource.find((row) => row.source === 'own_investment');
  assert.deepEqual(pick(own, ['status', 'actualYen', 'weightedYen', 'expectedYen']), {status: 'unconnected', actualYen: null, weightedYen: 900000, expectedYen: 900000});
  assert.equal(out.scenarios.standard.expectedYen, exactOf({...fx, facts: nulls}).expectedYen);
  for (const source of ['own_investment', 'committee', 'acquisition', 'consignment']) assert.ok(out.notes.some((note) => note.code === `${source}_unconnected`), source);
  // 項目が無いときも未接続
  const missing = normalizeScenarioFacts({opportunities: [], salesByWorkPartner: []});
  assert.deepEqual([missing.ownInvestment, missing.committee, missing.acquisition, missing.consignment], [null, null, null, null]);
  // 空の配列は接続済みの0件（0円）。出資の回収は合計に入る行が無いので unknown（回収済みと言わない）
  const empty = {...fx.facts, ownInvestment: [], committee: [], acquisition: [], consignment: []};
  const emptyOut = compareScenarios(request(), normalizeScenarioFacts(empty));
  assert.deepEqual(emptyOut.sources.filter((row) => row.source !== 'contract_work').map((row) => [row.status, row.actualYen]), [['connected', 0], ['connected', 0], ['connected', 0], ['connected', 0]]);
  assert.equal(emptyOut.creators.totalYen, 0);
  assert.deepEqual(pick(emptyOut.scenarios.standard.investmentRecovery.total, ['rowCount', 'diffYen', 'status']), {rowCount: 0, diffYen: null, status: 'unknown'});
  // 行はあるが額が全部未確定（委員会107だけ）なら unknown で null
  const unknownOnly = {...fx.facts, committee: fx.facts.committee.filter((row) => row.workId === 107)};
  const committee = compareScenarios(request(), normalizeScenarioFacts(unknownOnly)).sources.find((row) => row.source === 'committee');
  assert.deepEqual(pick(committee, ['status', 'actualYen', 'actualSalesYen', 'rowCount', 'unknownCount']), {status: 'unknown', actualYen: null, actualSalesYen: null, rowCount: 0, unknownCount: 1});
  assert.deepEqual(pick(committee, ['status', 'actualYen', 'actualSalesYen', 'rowCount', 'unknownCount']), goldenActuals(unknownOnly).committee);
});

test('要求の本文: basis・知らない項目・範囲の外の値は項目を添えて止め、目標額は応答にだけ使う', () => {
  const base = fixture().request;
  const body = (value) => field(() => normalizeCompareRequest(value));
  assert.equal(body({...base, basis: 'cash'}), 'basis');
  assert.equal(body({...base, fictional: true}), 'body.fictional');
  assert.equal(body({...base, stageProbabilityBps: {...base.stageProbabilityBps, lead: 10001}}), 'stageProbabilityBps.lead');
  assert.equal(body({...base, period: {from: '2026-04', to: '2026-03'}}), 'period.to');
  assert.equal(body({...base, opportunities: [...base.opportunities, {id: 1, source: 'consignment', conversionBps: 2000}]}), `opportunities[${base.opportunities.length}].id`);
  assert.equal(body({...base, actions: [{...base.actions[0], countX100: 1.5}]}), 'actions[0].countX100');
  assert.equal(body({...base, actions: [{...base.actions[0], dealYen: -1}]}), 'actions[0].dealYen');
  assert.equal(body({...base, targets: {selfYen: 0}}), 'targets.selfYen');
  assert.equal(body({...base, custom: {actions: [{source: 'committee', step: 'meeting', countX100: 100}]}}), 'custom.actions[0]');
  assert.equal(body(base), null);
  // 正規化は値を変えない（目標額を足しても他の項目はそのまま）
  const withTarget = normalizeCompareRequest({...base, targets: {selfYen: 4567891}});
  assert.deepEqual(withTarget.targets, {selfYen: 4567891});
  assert.equal(GRID_YEN, 10000);
});

test('model のシナリオは要求のカスタムの件数と前提だけを上書きする', () => {
  const req = request();
  assert.deepEqual(scenarioAssumptions(req, 'custom'), {...req.assumptions, proposalToContractBps: 3500});
  assert.deepEqual(scenarioActions(req, 'custom').map((row) => row.countX100), [600, 150, 100]);
  assert.deepEqual(scenarioAssumptions(req, 'pessimistic'), {...req.assumptions, salesMultiplierBps: 8500, recoveryAmountBps: 8500, proposalToContractBps: 2000, paymentDelayMonths: 1});
  assert.deepEqual(scenarioAssumptions(req, 'optimistic'), {...req.assumptions, salesMultiplierBps: 11500, recoveryAmountBps: 11500, proposalToContractBps: 4000, paymentDelayMonths: 0});
  const single = computeScenario(req, facts(), {assumptions: req.assumptions, actions: []});
  assert.equal(single.actionYen, 0);
  assert.deepEqual(single.quantiles, single.quantilesWithoutActions);
});

test('応答の金額（名前が …Yen の値）はどれも整数円か null で、端数の出る分布の平均を応答に出さない', () => {
  const targets = runtimeTargets();
  const out = run({targets: {selfYen: targets[1], companyYen: targets[2]}});
  assert.deepEqual(nonIntegerYen(out), []);
  for (const s of Object.values(out.scenarios)) {
    assert.equal(Object.hasOwn(s, 'meanYen'), false);
    // 分布の平均そのものは円の端数を持つ（応答に出せば整数円の約束を破る）
    assert.equal(Number.isInteger(meanOf(s.distribution.points)), false);
  }
});

test('分布の検算に失敗したときの誤りの文は、金額を含まず、どの分布か・内訳の数・許す幅の種類だけを書く', () => {
  const fx = fixture();
  const req = normalizeCompareRequest(fx.request);
  const scenario = computeScenario(req, normalizeScenarioFacts(fx.facts), {assumptions: req.assumptions, actions: scenarioActions(req, 'standard')});
  // 期待値を1億2,345万6,789円ずらして渡すと、分布の平均が許す幅を超えて離れる
  const wrong = scenario.expectedYen + 123456789;
  assert.throws(() => checkedDistribution(scenario.actualYen, scenario.opportunities, [], wrong, 'standard'), (error) => {
    assert.equal(error instanceof ScenarioInputError, false, '要求の本文の誤りではない（500 で受け止め口へ）');
    assert.match(error.message, /standard/);
    assert.match(error.message, /内訳 \d+個/);
    // 期待値・平均・幅の金額（3桁以上の数）を文に入れない
    assert.doesNotMatch(error.message, /\d{3,}|円/);
    return true;
  });
});

test('格子への寄せは half_up（ちょうど半分は0から遠ざける）、率の連なりと比は1回だけ truncate する', () => {
  assert.deepEqual([385000, 1125000, 15000, -15000, -25000, -14999, 4999, 5000].map((yen) => gridIndex(yen, 10000)), [39, 113, 2, -2, -3, -1, 0, 1]);
  // 率を別々に切らずに1回で: 7,025,000×400×20%×50%×30%÷100 = 843,000
  assert.equal(rateChain(2810000000n, [2000, 5000, 3000], {divisor: 100}), 843000);
  assert.equal(rateChain(-1001, [5000]), -500);
  assert.equal(rateChain(1001, [5000]), 500);
  assert.equal(ratioBps(18200000, 15000000), 12133);
  assert.equal(ratioBps(700000, 0), null);
  assert.equal(ratioBps(-1, 3), -3333);
});
