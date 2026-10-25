// 行動指標の計画 段B #15 の golden（test/fixtures/yojitsu/kpi-expected.json。build-kpi-expected.mjs が src を読まずに作る）の整合を確かめる。
// 種は案件収支の予実の架空の種（seed.json。フェーズ1 #23a）と、その延長（kpi-seed.json）と段B #9 の設定の行（kpi-metrics/seed.json）。
// 期待値は要件 docs/requirements/revenue/kpi-scenario-forecast.md の FR-REV-KPI-005・008・014・016・019・025・027・029・033・041・051 と、
// 計画の段B #15 の受け入れ基準（同じ種から2回作って同じ値・目標額を持たない・目標の行は fictional の印のまま・目標は粗利で測る・稼ぎ方は5つ）。
// 源泉別の実績はフェーズ1 の golden（expected.json）から、通過率・次の一手・予測誤差は種の行から、ここで別に数えるか手で数えた値と照らす。
// 段A の golden（test/fixtures/scenario/）がこのブランチにあれば、段A の入力をこの golden の計算に通して段A の golden と同じ値になることも確かめる。
// 目標額は実行時に不規則な桁で作る（golden・種には持たない）。設定の行を DB に入れる試験は ON_TEST_DB=pg で PostgreSQL でも流れる。架空のデータだけを使う
import test from 'node:test';
import assert from 'node:assert/strict';
import {existsSync, readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {openTestDb} from './test-db.mjs';
import * as planning from '../src/planning/planning-store.mjs';
import * as store from '../src/revenue/revenue-store.mjs';
import {seedKpiMetrics} from '../scripts/seed-kpi-metrics-demo.mjs';
import {EXPECTED_PATH, SOURCES, SCENARIO_KEYS, expectedText, buildKpiExpected, loadSeeds, scenarioCore, scenarioActions, distributionSummary, quantileYen,
  reachBps, probabilityPick, passRateRows, inputsFromStageA, distributionPoints, scenarioAssumptions, tornado, candidateDeltas, withoutFourItemsInputs, effectivePlan}
  from './fixtures/yojitsu/build-kpi-expected.mjs';

const ADMIN = 1; // 組織1の管理者（試作の行）
const OWNER = 'demo-admin@openingnight.invalid'; // 種の目標・計画の持ち主（行動指標の計画 A-4 の利用者。架空のアドレス）
const golden = JSON.parse(readFileSync(EXPECTED_PATH, 'utf8'));
const loaded = loadSeeds();
const seed = loaded.seed.json;
const kpiSeed = loaded.kpiSeed.json;
const p1 = loaded.p1.json;
const sum = (list, f = (x) => x) => list.reduce((n, x) => n + f(x), 0);
const EARNING = {買付: 'acquisition', 販売委託: 'consignment', 自社出資: 'own_investment', 製作委員会: 'committee', 制作受託: 'contract_work'};
const FOUR_ITEMS = ['自社出資の出資額', '製作委員会の出資額（自社の分）', '買付の MG', '買い切りの買付額'];
const inClosedPeriod = (month) => month >= golden.period.from && month <= golden.closedMonth;
const keysOf = (v, out = []) => {
  if (Array.isArray(v)) for (const x of v) keysOf(x, out);
  else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) { out.push(k); keysOf(x, out); }
  return out;
};
const numbersOf = (v, out = []) => {
  if (Array.isArray(v)) for (const x of v) numbersOf(x, out);
  else if (v && typeof v === 'object') for (const x of Object.values(v)) numbersOf(x, out);
  else if (typeof v === 'number') out.push(v);
  return out;
};
const distOf = (inputs, key) => scenarioCore(inputs, {assumptions: scenarioAssumptions(inputs, key), actions: scenarioActions(inputs, key)});

test('FR-REV-KPI-051 段B #15: golden は同じ種から2回作って同じ値になり、置いてある kpi-expected.json と同じ。種を変えると golden が変わる', () => {
  const first = expectedText();
  assert.equal(expectedText(), first);
  assert.equal(readFileSync(EXPECTED_PATH, 'utf8').replace(/\r\n/g, '\n'), first, 'golden は今の種から作り直してある（node test/fixtures/yojitsu/build-kpi-expected.mjs）');
  // 種の SHA-256 を持つので、延長の種だけ直して golden を作り直し忘れると落ちる
  assert.notEqual(expectedText({...loaded, kpiSeed: {...loaded.kpiSeed, text: `${loaded.kpiSeed.text} `}}), first);
  // 稼ぎ方は5つで源泉と1対1（J-2 (a)・J-3 (a)）
  assert.deepEqual(SOURCES, ['contract_work', 'own_investment', 'committee', 'acquisition', 'consignment']);
  assert.deepEqual(golden.sourceProfit.cash.bySource.map((r) => r.source), SOURCES);
  assert.deepEqual(Object.keys(golden.scenarios), SCENARIO_KEYS);
});

test('FR-REV-KPI-016 段B #15 #23: 延長の種と golden は架空の印つきで、目標・報酬・家賃補助の鍵と目標・計画の額を持たない。フェーズ1 の目標・計画の行は架空の印と demo-admin の持ち主のまま', () => {
  assert.equal(kpiSeed.fictional, true);
  assert.equal(golden.fictional, true);
  for (const doc of [kpiSeed, golden]) {
    for (const k of keysOf(doc)) assert.doesNotMatch(k, /target|self|company|salary|wage|payroll|rent|compensation|目標|報酬|家賃/i, `鍵 ${k}`);
  }
  // 種の目標・計画の額（不規則な桁の架空額）が golden の数のどこにも出ない（目標に依る値は試験が実行時に作る目標額で数える）
  const amounts = new Set([...seed.目標.map((r) => r['目標額（円）']), ...seed.計画.map((r) => r['計画額（円・税別）'])]);
  const hits = numbersOf(golden).filter((n) => amounts.has(n));
  assert.deepEqual(hits, []);
  // フェーズ1 #23a の目標・計画・採用の記録の行は fictional の印で、持ち主は画面を全部見る利用者（段B #15 の種の持ち主）
  for (const r of [...seed.目標, ...seed.計画, ...seed.plan_adoptions]) {
    assert.equal(r.fictional, true);
    assert.equal(r.owner_user_email, OWNER);
  }
  // 計画の版の額に依る値（源泉の偏りの率）には架空の印
  assert.equal(golden.proposals.shortfall.fictional, true);
});

test('FR-REV-KPI-005 段B #2 #15: 源泉別の実績はフェーズ1 の golden の利益額の明細（確定）を稼ぎ方で分けた和で、合計は期間内の利益額と一致し、4費目を引かない粗利＝粗利＋4費目', () => {
  for (const basis of ['cash', 'accrual']) {
    const rows = p1.利益額.明細.filter((d) => d.基準 === basis && inClosedPeriod(d.月) && d.状態 === '確定');
    const g = golden.sourceProfit[basis];
    for (const source of SOURCES) {
      const mine = rows.filter((d) => EARNING[d.稼ぎ方] === source);
      const sales = sum(mine.filter((d) => d.向き === '売上'), (d) => d.額);
      const cost = sum(mine.filter((d) => d.向き === '経費'), (d) => d.額);
      const four = sum(mine.filter((d) => FOUR_ITEMS.includes(d.費目)), (d) => d.額);
      const row = g.bySource.find((r) => r.source === source);
      assert.deepEqual([row.status, row.salesYen, row.costYen, row.profitYen, row.fourItemsYen, row.profitWithoutFourItemsYen],
        ['connected', sales, cost, sales - cost, four, sales - cost + four], `${basis} ${source}`);
    }
    const months = p1.利益額.月;
    const p1Total = months.reduce((n, m, i) => (inClosedPeriod(m) ? n + p1.利益額.基準[basis].確定.利益額[i] : n), 0);
    assert.equal(g.total.profitYen, p1Total, `${basis} の源泉別の粗利の和＝フェーズ1 の利益額（P1 #14b と合計が一致）`);
  }
  // 段B のシナリオの実績は入金の基準の源泉別の粗利（4段は入金に固定）
  const s = golden.scenarios.standard;
  assert.deepEqual(s.bySource.map((r) => r.actualYen), golden.sourceProfit.cash.bySource.map((r) => r.profitYen));
  assert.equal(golden.inputs.basis, 'cash');
});

test('FR-REV-KPI-006 段B #3 #15: 受託制作の契約の版が無ければ源泉1の実績は未接続（null）で0円で埋めず、期待値は確度加重と行動からの見込だけで出る', () => {
  const without = buildKpiExpected({...loaded, kpiSeed: {...loaded.kpiSeed, json: {...kpiSeed, contractVersions: []}}});
  const row = without.sourceProfit.cash.bySource.find((r) => r.source === 'contract_work');
  assert.deepEqual([row.status, row.salesYen, row.profitYen], ['unconnected', null, null]);
  const s = without.scenarios.standard.bySource.find((r) => r.source === 'contract_work');
  assert.equal(s.actualYen, null);
  assert.equal(s.expectedYen, s.weightedYen + s.actionYen);
  // 延長の種の版（YJ-P25）があれば接続し、締めた月までの節目が無いので実績は0円
  assert.deepEqual(golden.sourceProfit.cash.bySource.find((r) => r.source === 'contract_work').status, 'connected');
});

test('FR-REV-KPI-008 段B #5 #15: 出資者が複数の製作委員会は自社の払込と自社の取得額だけを数え、他の出資者の払込（延長の種）を源泉3に入れない', () => {
  const withMembers = golden.committees.filter((c) => c.investments.some((x) => x.memberCount >= 3));
  assert.ok(withMembers.length >= 1);
  const projectOfWork = new Map(seed.works.map((w) => [w.work_code, w.project_code]));
  for (const c of golden.committees.filter((x) => x.investments.length)) {
    // 自社の払込（期間内・種の時点まで）を種の出資の記録から、他の出資者の払込を延長の種から別に数える
    const invs = seed.investments.filter((x) => x.kind === '製作委員会' && projectOfWork.get(x.work_code) === c.projectCode);
    const own = invs.flatMap((x) => x.payments).filter((q) => q.paid_on <= seed.as_of && inClosedPeriod(q.paid_on.slice(0, 7)));
    const others = kpiSeed.memberPayments.filter((m) => invs.some((x) => x.investment_id === m.investmentId) && m.paidOn <= seed.as_of && inClosedPeriod(m.paidOn.slice(0, 7)));
    assert.equal(c.ownPaidPeriodYen, sum(own, (q) => q.amount_yen), c.projectCode);
    assert.equal(c.otherMembersPaidPeriodYen, sum(others, (m) => m.amountYen), c.projectCode);
    for (const x of c.investments) for (const m of x.otherMembers) assert.equal(m.counted, false);
  }
  // 期間内に他の出資者が払い込んだ委員会があり（YJ-P13）、源泉3の経費は自社の払込だけ
  assert.ok(golden.committees.some((c) => c.otherMembersPaidPeriodYen > 0));
  const s3 = golden.sourceProfit.cash.bySource.find((r) => r.source === 'committee');
  assert.equal(s3.costYen, sum(golden.committees, (c) => c.ownPaidPeriodYen ?? 0));
  assert.equal(s3.profitYen, sum(golden.committees, (c) => c.acquisitionsMinusOwnPaidPeriodYen ?? 0));
});

test('FR-REV-KPI-005 FR-REV-KPI-027 FR-REV-KPI-033 段B #12 #15: 3シナリオの期待値は内訳の整数の和で源泉別の合計と同じ。悲観 ≤ 標準 ≤ 楽観。golden の入力から作り直した分布の要約・分位点が golden と同じ', () => {
  for (const key of SCENARIO_KEYS) {
    const s = golden.scenarios[key];
    assert.equal(s.expectedYen, s.actualYen + s.weightedYen + s.actionYen, key);
    assert.equal(s.expectedYen, sum(s.bySource, (r) => r.expectedYen ?? 0), key);
    assert.equal(s.expectedSalesYen, sum(s.bySource, (r) => r.expectedSalesYen ?? 0), key);
    assert.equal(s.weightedYen, sum(s.projects.filter((r) => r.placement === 'in_period'), (r) => r.weightedYen), key);
    assert.equal(s.actionYen, sum(s.actionRows, (r) => r.expectedYen), key);
    for (const r of s.projects) assert.equal(r.weightedYen, Math.trunc((r.valueYen * r.probabilityBps) / 10000), `${key} ${r.projectCode} は2段の truncate`);
    const d = distOf(golden.inputs, key);
    assert.deepEqual(distributionSummary(d.dist), s.distribution, key);
    assert.deepEqual({p10Yen: quantileYen(d.dist, 1, 10), p50Yen: quantileYen(d.dist, 1, 2), p90Yen: quantileYen(d.dist, 9, 10)}, s.quantiles, key);
    assert.ok(s.quantiles.p10Yen <= s.quantiles.p50Yen && s.quantiles.p50Yen <= s.quantiles.p90Yen, key);
    // 4費目を引かない場合は、実績が4費目を引かない粗利になり、期待値は引く場合以上（4費目は出金なので）
    assert.equal(s.withoutFourItems.actualYen, golden.sourceProfit.cash.total.profitWithoutFourItemsYen, key);
    assert.ok(s.withoutFourItems.expectedYen >= s.expectedYen, key);
    assert.equal(distOf(withoutFourItemsInputs(golden.inputs), key).expectedYen, s.withoutFourItems.expectedYen, key);
  }
  const {standard, optimistic, pessimistic} = golden.scenarios;
  assert.ok(pessimistic.expectedYen <= standard.expectedYen && standard.expectedYen <= optimistic.expectedYen);
  assert.ok(pessimistic.quantiles.p50Yen <= standard.quantiles.p50Yen && standard.quantiles.p50Yen <= optimistic.quantiles.p50Yen);
  // 入金の遅れは悲観の側だけ動かす（K2-4）
  assert.deepEqual([optimistic.assumptions.paymentDelayMonths, standard.assumptions.paymentDelayMonths, pessimistic.assumptions.paymentDelayMonths], [0, 0, 1]);
  // 効きと候補は golden の入力から作り直しても同じ
  assert.deepEqual(tornado(golden.inputs), golden.tornado);
  assert.deepEqual(candidateDeltas(golden.inputs), golden.candidates);
});

test('FR-REV-KPI-014 FR-REV-KPI-025 FR-REV-KPI-041 段B #14 #15: 目標に依る値は実行時の架空の目標額で分布から数え、届く確率は 悲観 ≤ 標準 ≤ 楽観。提案の1つ目は1時間あたりの確率の増分の順', () => {
  // 実行時に作る架空の目標額（不規則な桁。golden・種には持たない）。目標は粗利で測る（J-12 (c)）ので粗利の分布の50%点の近く
  const target = golden.scenarios.standard.quantiles.p50Yen + 13579;
  const reach = Object.fromEntries(SCENARIO_KEYS.map((key) => [key, reachBps(distOf(golden.inputs, key).dist, target)]));
  assert.ok(reach.standard > 0 && reach.standard < 10000);
  assert.ok(reach.pessimistic <= reach.standard && reach.standard <= reach.optimistic, JSON.stringify(reach));
  const pick = probabilityPick(golden.inputs, target);
  assert.deepEqual(pick.map((r) => `${r.source}:${r.step}`).sort(), golden.candidates.map((r) => `${r.source}:${r.step}`).sort());
  for (const r of pick) {
    assert.equal(r.reachBeforeBps, reach.standard);
    assert.ok(r.reachAfterBps >= r.reachBeforeBps, '行動を1件足しても届く確率は下がらない（どの行動も1件の粗利が正）');
    assert.equal(r.expectedDeltaYen, golden.candidates.find((c) => c.source === r.source && c.step === r.step).expectedDeltaYen);
  }
  // 並びは bp に丸める前の正確な増分÷時間の順。丸めた bp の増分は正確な値から ±1 なので、前の候補の (増分＋1)÷時間 は後の候補の (増分−1)÷時間 以上
  for (let i = 0; i + 1 < pick.length; i++) {
    const [a, b] = [pick[i], pick[i + 1]];
    const da = a.reachAfterBps - a.reachBeforeBps, db = b.reachAfterBps - b.reachBeforeBps;
    assert.ok((da + 1) * b.hoursX100 >= (db - 1) * a.hoursX100, `${a.source}:${a.step} は ${b.source}:${b.step} より前`);
  }
  // 候補ごとに分布の分母（10^exp）が違う（面談は +8、提案は +4）。届く確率の増分を分数のまま（分子と分母）持ち、
  // 増分a÷時間a と 増分b÷時間b を分母を掛け合わせて比べた並びと、probabilityPick の並びが同じ。制作受託の提案の1件の時間を変えて確かめる
  const assumptions = scenarioAssumptions(golden.inputs, 'standard');
  const hitOf = (dist) => {
    let hit = 0n;
    for (const [grid, p] of dist.dist) if (BigInt(grid) * 10000n >= BigInt(target)) hit += p;
    return {hit, den: 10n ** BigInt(dist.exp)};
  };
  const base = distOf(golden.inputs, 'standard');
  const before = hitOf(base.dist);
  const deltas = golden.inputs.actions.map((a, i) => {
    const more = golden.inputs.actions.map((x, j) => (j === i ? {...x, countX100: x.countX100 + 100} : x));
    const after = scenarioCore(golden.inputs, {assumptions, actions: more});
    const h = hitOf(after.dist);
    return {key: `${a.source}:${a.step}`, source: a.source, num: h.hit * before.den - before.hit * h.den, den: h.den * before.den, expectedDeltaYen: after.expectedYen - base.expectedYen};
  });
  assert.ok(new Set(deltas.map((d) => d.den)).size > 1, '候補の分母が違う種で確かめる');
  const handOrder = {800: ['acquisition:meeting', 'contract_work:proposal', 'consignment:meeting'], 400: ['acquisition:meeting', 'contract_work:proposal', 'consignment:meeting'],
    300: ['contract_work:proposal', 'acquisition:meeting', 'consignment:meeting']};
  for (const hours of [800, 400, 300]) {
    const hoursOf = (source) => (source === 'contract_work' ? hours : golden.inputs.actions.find((a) => a.source === source).hoursX100);
    const want = [...deltas].sort((x, y) => {
      const l = x.num * y.den * BigInt(hoursOf(y.source)), r = y.num * x.den * BigInt(hoursOf(x.source));
      return l > r ? -1 : l < r ? 1 : y.expectedDeltaYen - x.expectedDeltaYen || (x.key < y.key ? -1 : 1);
    }).map((x) => x.key);
    const inputs = {...golden.inputs, actions: golden.inputs.actions.map((a) => ({...a, hoursX100: hoursOf(a.source)}))};
    assert.deepEqual(probabilityPick(inputs, target).map((r) => `${r.source}:${r.step}`), want, `制作受託の提案 ${hours / 100} 時間`);
    // 手で確かめた並び（提案の増分は約340bp・買付の面談は約297bp・委託の面談は約100bp）
    assert.deepEqual(want, handOrder[hours], `制作受託の提案 ${hours / 100} 時間`);
  }
});

test('FR-REV-KPI-029 段B #11 #15: 通過率は段 s の活動記録があった案件のうち次の段の記録がある案件の数。種は件数不足（9件未満）で仮置きの率を当て、9件以上なら観測の率を当てる', () => {
  const r = golden.stageRates;
  assert.deepEqual([r.windowMonths, r.minCountX100, r.from, r.to], [12, 900, '2025-12', '2026-11']);
  const row = (source, step) => r.rows.find((x) => x.source === source && x.step === step);
  // 種の活動記録から手で数えた値
  assert.deepEqual(pickRow(row('contract_work', 'planning_memo')), {count: 7, advancedCount: 5, observedRateBps: 7142, status: 'insufficient', appliedRateBps: 5000});
  assert.deepEqual(row('contract_work', 'planning_memo').projectCodes, ['YJ-P25', 'YJ-P26', 'YJ-P27', 'YJ-P28', 'YJ-P29', 'YJ-P30', 'YJ-P32']);
  assert.deepEqual(pickRow(row('consignment', 'term_sheet')), {count: 4, advancedCount: 1, observedRateBps: 2500, status: 'insufficient', appliedRateBps: 3000});
  assert.deepEqual(pickRow(row('committee', 'committee_sounding')), {count: 2, advancedCount: 2, observedRateBps: 10000, status: 'insufficient', appliedRateBps: 3000});
  assert.deepEqual(pickRow(row('own_investment', 'approval_decision')), {count: 0, advancedCount: 0, observedRateBps: null, status: 'insufficient', appliedRateBps: 10000});
  for (const x of r.rows) assert.equal(x.appliedRateBps, x.provisionalRateBps, `${x.source} ${x.step}`);
  // 架空の小さな入力: 9件で measured、次の段の記録が段 s の最初の記録より前の案件と窓の外の記録は数えない
  const records = [];
  for (let i = 1; i <= 9; i++) records.push({project: `X${i}`, earningType: 'consignment', step: 'a', on: '2026-06-10'});
  for (let i = 1; i <= 6; i++) records.push({project: `X${i}`, earningType: 'consignment', step: 'b', on: '2026-07-01'});
  records.push({project: 'X7', earningType: 'consignment', step: 'b', on: '2026-06-01'}); // 段 a より前
  records.push({project: 'X8', earningType: 'consignment', step: 'b', on: '2026-12-01'}); // 窓の外
  records.push({project: 'X10', earningType: 'consignment', step: 'a', on: '2025-11-30'}); // 窓の外
  records.push({project: 'X11', earningType: 'acquisition', step: 'a', on: '2026-06-10'}); // 別の稼ぎ方
  const chains = [{role: 'sales_sourcing', earningType: 'consignment', steps: ['a', 'b', 'c']}];
  const args = {records, chains, fromDate: '2025-12-01', toDate: '2026-11-31', minCountX100: 900, provisionalRate: () => 5000};
  const [ab, bc] = passRateRows(args);
  assert.deepEqual(pickRow(ab), {count: 9, advancedCount: 6, observedRateBps: 6666, status: 'measured', appliedRateBps: 6666});
  assert.deepEqual(pickRow(bc), {count: 7, advancedCount: 0, observedRateBps: 0, status: 'insufficient', appliedRateBps: 5000});
  assert.equal(passRateRows({...args, records: records.filter((x) => x.project !== 'X9')})[0].status, 'insufficient');
});
function pickRow(x) {
  return {count: x.count, advancedCount: x.advancedCount, observedRateBps: x.observedRateBps, status: x.status, appliedRateBps: x.appliedRateBps};
}

test('FR-REV-KPI-041 FR-REV-FCST-018 段B #14 #15: 見直しの提案の4条件（期限切れ・予測誤差・源泉の偏り・件数不足）と、いちばん足りない稼ぎ方の候補。提案の行は参照 ID と率だけ', () => {
  const p = golden.proposals;
  // 次の一手の期限切れ: 案件の最後の活動記録の期日が種の時点より前（種から別に数える）
  const last = new Map();
  seed.活動記録.forEach((r, i) => {
    const prev = last.get(r.案件コード);
    if (!prev || r.日付 > prev.r.日付 || (r.日付 === prev.r.日付 && i > prev.i)) last.set(r.案件コード, {r, i});
  });
  const overdue = [...last.values()].filter(({r}) => r.期日 !== null && r.期日 < seed.as_of).map(({r}) => r.案件コード).sort();
  assert.deepEqual(p.conditions.overdueNextAction.rows.map((r) => r.projectCode), overdue);
  assert.deepEqual(overdue, ['YJ-P21', 'YJ-P23']);
  // 予測誤差: しきい値は予測の売上の10%と1万円の大きいほう（FR-REV-FCST-018）。種は予測の版のある2件とも内側、版の無い8件は予測外
  for (const r of p.forecastErrorDetail) {
    assert.equal(r.thresholdYen, Math.max(Math.trunc(r.forecastSalesYen / 10), 10000));
    assert.equal(r.exceeded, Math.abs(r.actualSalesYen - r.forecastSalesYen) > r.thresholdYen);
  }
  assert.deepEqual(p.forecastErrorDetail.map((r) => [r.projectCode, r.month, r.exceeded]), [['YJ-P01', '2026-11', false], ['YJ-P05', '2026-11', false]]);
  assert.equal(p.conditions.forecastError.unforecastCount, 8);
  // 源泉の偏り: 期待値の会社の売上÷有効な計画の版の率がいちばん小さい稼ぎ方と、その稼ぎ方の候補の上位1つ
  const worst = [...p.shortfall.ratios].sort((a, b) => a.ratioBps - b.ratioBps)[0];
  assert.equal(p.shortfall.mostShortSource, worst.source);
  assert.deepEqual(p.shortfall.pick, {...pickCandidate(golden.candidates.find((c) => c.source === worst.source))});
  assert.equal(p.conditions.sourceImbalance.triggered, p.shortfall.ratios.some((r) => r.ratioBps < 10000));
  // 件数不足は通過率の insufficient の行
  assert.equal(p.conditions.insufficientRate.rows.length, golden.stageRates.rows.filter((r) => r.status === 'insufficient').length);
  assert.equal(p.triggered, Object.values(p.conditions).some((c) => c.triggered));
  // 提案の根拠は参照 ID と率だけ（金額の鍵を持たない）
  for (const k of keysOf(p.conditions)) assert.doesNotMatch(k, /Yen$/, k);
  assert.equal(p.probabilityPick.computedAtRuntime, true);
});
function pickCandidate(c) {
  return {source: c.source, step: c.step, addCountX100: c.addCountX100};
}

// 生成スクリプトの関数を通さずに、種から別に数えるか申し送りから手で写した基準値（golden を作り直しただけで緑にならない。#9 の確かめと同じ穴をふさぐ）
test('FR-REV-KPI-051 段B #15: 期間・標準の前提・段階の確度・行動の件数と時間・案件別の見込と確度加重と来期・出資の回収・有効な計画の版が、種から別に数えた値と手で写した値と同じ', () => {
  // 期間: 種の設定の期間のうち締めた月（2026-11）を含む1年目と、来期の2年目。種の時点は 2026-11-30（手で写した値）
  assert.deepEqual(golden.period, {name: '1年目', from: '2026-10', to: '2027-09', nextFrom: '2027-10', nextTo: '2028-09'});
  assert.deepEqual([golden.closedMonth, golden.asOf], ['2026-11', '2026-11-30']);
  const AFTER_CLOSED = '2026-11', PERIOD_END = '2027-09', NEXT_END = '2028-09';
  // 標準の前提: 倍率と回収の量は100%、面談→提案50%・提案→契約30%（フェーズ1 #23a の行動の行）、入金の遅れ0（申し送り §仮置きの値）
  const standard = {salesMultiplierBps: 10000, recoveryAmountBps: 10000, meetingToProposalBps: 5000, proposalToContractBps: 3000, paymentDelayMonths: 0};
  assert.deepEqual(golden.settings.standardAssumptions, standard);
  assert.deepEqual(golden.inputs.assumptions, standard);
  // 段階の確度は種の段階の表のまま
  const stageProb = Object.fromEntries(seed.vocabulary.stages.map((s) => [s.name, s.probability_bps]));
  assert.deepEqual(golden.settings.stageProbabilityBps, stageProb);
  // 行動: 延長の種の行動の計画のうち 2026-12〜2027-09 の件数（締めた月と期間の後は入らない）。1件の時間は申し送り §行動の表
  // （受託の提案1件＝企画メモ4件×4時間＋予算割と見積2件×8時間＋提案8時間＝40時間、買付・委託の面談1件＝3時間）、1件の額は P1 #23a の行動の行
  const STEP = {面談: 'meeting', 提案: 'proposal'};
  const counts = {};
  for (const a of kpiSeed.actionPlan) {
    const m = a.month.slice(0, 7);
    if (m > AFTER_CLOSED && m <= PERIOD_END) counts[`${EARNING[a.earningType]}:${STEP[a.step]}`] = (counts[`${EARNING[a.earningType]}:${STEP[a.step]}`] || 0) + a.countX100;
  }
  assert.deepEqual(counts, {'consignment:meeting': 300, 'acquisition:meeting': 450, 'contract_work:proposal': 500});
  const unit = (label) => seed.行動.find((r) => r.稼ぎ方 === label)['1件あたりの額（円・税別）'];
  const rate = (label) => seed.vocabulary.earning_types.find((e) => e.name === label).default_sales_rate_bps;
  assert.deepEqual(Object.fromEntries(golden.inputs.actions.map((a) => [`${a.source}:${a.step}`, [a.countX100, a.hoursX100, a.dealYen, a.conversionBps]])), {
    'consignment:meeting': [300, 300, unit('販売委託'), rate('販売委託')],
    'acquisition:meeting': [450, 300, unit('買付'), rate('買付')],
    'contract_work:proposal': [500, 4000, unit('制作受託'), rate('制作受託')],
  });
  // 案件別: 予測に使う印の行（採用シナリオか単一）を、締めた月の次の月〜期間の終わりと来期で別に足す。売上の区分は入金の3つ、4費目の区分は出資と買付の出金
  const REVENUE = ['流通売上', '販売委託の売上', '受託収益'];
  const FOUR = ['出資', '買付'];
  assert.deepEqual(seed.vocabulary.kubun.filter((k) => k.direction === '入金' && k.sales_source === 'はい').map((k) => k.name).sort(), [...REVENUE].sort());
  const adopted = seed.設定.採用シナリオ;
  const yen = (rows) => sum(rows, (r) => r['金額（円・税別）']);
  const std = golden.scenarios.standard;
  const mine = new Map();
  for (const p of seed.案件) {
    const used = seed.予測.filter((r) => r.案件コード === p.案件コード && r.予測に使う === 'はい' && (r.シナリオ === adopted || r.シナリオ === '単一'));
    const between = (lo, hi) => used.filter((r) => r.月.slice(0, 7) > lo && r.月.slice(0, 7) <= hi);
    const inP = between(AFTER_CLOSED, PERIOD_END), next = between(PERIOD_END, NEXT_END);
    const prob = stageProb[p.段階];
    const g = golden.projects.find((r) => r.projectCode === p.案件コード);
    assert.equal(g.probabilityBps, prob, p.案件コード);
    const reason = p.段階 === '見送り' ? 'declined' : !inP.length && !next.length ? 'no_forecast' : null;
    assert.equal(g.excludedReason, reason, p.案件コード);
    if (reason) continue;
    const rev = yen(inP.filter((r) => REVENUE.includes(r.区分))), ded = yen(inP.filter((r) => FOUR.includes(r.区分)));
    const value = Math.trunc((rev * p.rate_bps) / 10000) - ded;
    const weighted = Math.trunc((value * prob) / 10000);
    assert.deepEqual([g.revenueBaseYen, g.deductionYen, g.valueYen, g.weightedYen], [rev, ded, value, weighted], p.案件コード);
    const nextValue = Math.trunc((yen(next.filter((r) => REVENUE.includes(r.区分))) * p.rate_bps) / 10000) - yen(next.filter((r) => FOUR.includes(r.区分)));
    const s = std.projects.find((r) => r.projectCode === p.案件コード);
    assert.deepEqual([s.placement, s.nextPeriodValueYen, s.nextPeriodWeightedYen], [inP.length ? 'in_period' : 'after_period', nextValue, Math.trunc((nextValue * prob) / 10000)], p.案件コード);
    mine.set(p.案件コード, {prob, value, weighted, inPeriod: inP.length > 0, investment: yen(inP.filter((r) => r.区分 === '出資'))});
  }
  assert.equal(std.weightedYen, sum([...mine.values()].filter((r) => r.inPeriod), (r) => r.weighted));
  // 出資の回収: 自社出資＝出資の記録の自社の出資額（版の出資額）、製作委員会＝種の時点までの自社の払込（YJ-P13 は 2026-11-16 の 7,272,000円だけで、
  // 2027-01-15 の予定の払込を数えない）。収益は P1 の golden の利益額の明細（入金・売上・確定）の締めた月までの和。期末の見込みは、製作委員会が確度加重、
  // 自社出資は予定の払込（予測の出資の区分）を足し戻した見込×確度
  const projectOfWork = new Map(seed.works.map((w) => [w.work_code, w.project_code]));
  const salesUntil = (code, from) => sum(p1.利益額.明細.filter((d) => d.基準 === 'cash' && d.案件コード === code && d.向き === '売上' && d.状態 === '確定'
    && d.月 >= from && d.月 <= golden.closedMonth), (d) => d.額);
  const invested = seed.案件.filter((p) => ['自社出資', '製作委員会'].includes(p.稼ぎ方) && seed.investments.some((x) => projectOfWork.get(x.work_code) === p.案件コード))
    .map((p) => p.案件コード).sort();
  assert.deepEqual(std.investmentRecovery.rows.map((r) => r.projectCode), invested);
  for (const r of std.investmentRecovery.rows) {
    const invs = seed.investments.filter((x) => projectOfWork.get(x.work_code) === r.projectCode);
    const own = seed.案件.find((p) => p.案件コード === r.projectCode).稼ぎ方 === '自社出資';
    const investmentYen = own ? sum(invs, (x) => x.own_yen) : sum(invs.flatMap((x) => x.payments).filter((q) => q.paid_on <= seed.as_of), (q) => q.amount_yen);
    const m = mine.get(r.projectCode);
    const remaining = !m?.inPeriod ? 0 : own ? Math.trunc(((m.value + m.investment) * m.prob) / 10000) : m.weighted;
    assert.deepEqual([r.investmentYen, r.revenueYen, r.periodRevenueYen, r.remainingExpectedYen, r.projectedDiffYen],
      [investmentYen, salesUntil(r.projectCode, '0000-00'), salesUntil(r.projectCode, golden.period.from), remaining, salesUntil(r.projectCode, '0000-00') - investmentYen + remaining], r.projectCode);
  }
  assert.equal(std.investmentRecovery.rows.find((r) => r.projectCode === 'YJ-P13').investmentYen, 7272000);
  // 有効な計画の版: 1年目の採用の記録は 2026-10-02 に版1、2026-11-16 に版2（手で写した値）。源泉の偏りの率は版2の計画額で割った値
  assert.equal(golden.proposals.shortfall.planVersionNo, 2);
  for (const r of golden.proposals.shortfall.ratios) {
    const plan = seed.計画.find((x) => x.期間 === '1年目' && x.版 === 2 && EARNING[x.稼ぎ方] === r.source)['計画額（円・税別）'];
    assert.equal(r.ratioBps, Math.trunc((std.bySource.find((x) => x.source === r.source).expectedSalesYen * 10000) / plan), r.source);
  }
});

test('段B #15: 有効な計画の版は採用の記録の行の並びに依らず、同じ日の採用は版の番号の大きいほう、種の時点より後の採用は数えない', () => {
  const period = golden.period;
  assert.equal(effectivePlan(seed, period).versionNo, 2);
  assert.equal(effectivePlan({...seed, plan_adoptions: [...seed.plan_adoptions].reverse()}, period).versionNo, 2);
  // 種の時点より後に版1を採り直した記録は数えない
  const later = {...seed.plan_adoptions.find((a) => a.period === '1年目' && a.version_no === 1), adopted_on: '2026-12-05'};
  assert.equal(effectivePlan({...seed, plan_adoptions: [later, ...seed.plan_adoptions]}, period).versionNo, 2);
  // 版2と同じ日に採った版3（版2の行の写し）を版2より前の行に置いても版3
  const v2 = seed.plan_adoptions.find((a) => a.period === '1年目' && a.version_no === 2);
  const withV3 = {...seed, plan_adoptions: [{...v2, version_no: 3}, ...seed.plan_adoptions],
    計画: [...seed.計画, ...seed.計画.filter((r) => r.期間 === '1年目' && r.版 === 2).map((r) => ({...r, 版: 3}))]};
  assert.equal(effectivePlan(withV3, period).versionNo, 3);
  // 採用の記録の行を逆に並べた種から作っても、見直しの提案（源泉の偏りの率と提案の2つ目）は golden と同じ
  const reversed = buildKpiExpected({...loaded, seed: {...loaded.seed, json: {...seed, plan_adoptions: [...seed.plan_adoptions].reverse()}}});
  assert.deepEqual(reversed.proposals, golden.proposals);
  assert.deepEqual(reversed.branchCases.awaitingExcluded, golden.branchCases.awaitingExcluded);
});

test('FR-REV-KPI-029 FR-REV-KPI-041 FR-REV-KPI-049 段B #15: 種の本体では通らない分岐（branchCases）を、延長の種の架空の小さな入力から手で数えた値で固定する', () => {
  const b = golden.branchCases;
  // (0) 期間の境界: 期間内は 2026-12 の 2,000,000円と 2027-09 の 3,000,000円（締めた月 2026-11・MAX・予測に使わない版は数えない）と買付の出金 500,000円、
  // 来期は 2027-10 の 4,000,000円と 2028-09 の 5,000,000円（2028-10 は数えない）。行動は 2026-12 と 2027-09 の2件（締めた月と期間の後は入らない）
  const [item] = b.periodBoundary.items;
  assert.deepEqual([item.key, item.placement, item.probabilityBps, item.inPeriod, item.nextPeriod], ['YJ-X31', 'in_period', 8000,
    {revenueBaseYen: 5000000, deductionYen: 500000}, {revenueBaseYen: 9000000, deductionYen: 0}]);
  assert.deepEqual(item.cash, [{month: '2026-12', baseYen: 2000000}, {month: '2027-09', baseYen: 3000000}, {month: '2027-10', baseYen: 4000000}, {month: '2028-09', baseYen: 5000000}]);
  assert.deepEqual(b.periodBoundary.actions.map((a) => [a.source, a.step, a.countX100, a.hoursX100]), [['acquisition', 'meeting', 200, 300]]);
  // (1) 予測誤差（売上率 20%。しきい値＝予測の売上の10%と1万円の大きいほう、差がしきい値を「超えた」とき）
  assert.deepEqual(b.forecastError.rows.map((r) => [r.projectCode, r.month, r.forecastVersion, r.actualSalesYen, r.forecastSalesYen, r.thresholdYen, r.exceeded, r.direction, r.ratioBps]), [
    ['YJ-X01', '2026-10', '架空の版 第1版', 2000000, 1400000, 140000, true, 'over', 14285], // MAX の行・期間の前と締めた月の後の入金は数えない
    ['YJ-X02', '2026-11', '架空の版 第1版', 600000, 1000000, 100000, true, 'under', 6000],
    ['YJ-X03', '2026-11', '架空の版 第1版', 1100000, 1000000, 100000, false, 'over', 11000], // 差がしきい値ちょうど
    ['YJ-X04', '2026-11', '架空の版 第1版', 62000, 50000, 10000, true, 'over', 12400], // 10%（5,000円）より1万円の床
    ['YJ-X05', '2026-11', '架空の版 第1版', 58000, 50000, 10000, false, 'over', 11600], // 10% は超えるが床の内側
    ['YJ-X06', '2026-11', '架空の版 第1版', 1100000, 1000000, 100000, false, 'over', 11000], // 最初の入金（11-10）の日より後に作った第2版は使わない
  ]);
  assert.equal(b.forecastError.unforecastCount, 1);
  // (2) 次の一手（種の時点 2026-11-30）
  assert.deepEqual(b.nextAction.map((r) => [r.projectCode, r.recordedOn, r.dueOn, r.hasNextAction, r.overdue]), [
    ['YJ-X21', '2026-11-10', '2026-11-30', true, false], // 期日が種の時点と同じ日は期限切れでない
    ['YJ-X22', '2026-11-10', '2026-11-29', true, true],
    ['YJ-X23', '2026-11-25', '2026-12-05', true, false], // 後の日の記録が、後ろの行の前の日の記録より勝つ
    ['YJ-X24', '2026-11-12', '2026-11-15', true, true], // 同じ日は後ろの行
    ['YJ-X25', '2026-11-15', null, false, false],
  ]);
  // (3) 通過率（窓 2025-12-01〜2026-11-30、最小件数9件）
  const rate = (source, step) => pickRow(b.passRate.find((r) => r.source === source && r.step === step));
  assert.deepEqual(rate('consignment', 'rights_holder_meeting'), {count: 9, advancedCount: 6, observedRateBps: 6666, status: 'measured', appliedRateBps: 6666});
  assert.deepEqual(b.passRate.find((r) => r.source === 'consignment' && r.step === 'rights_holder_meeting').advancedProjectCodes,
    ['YJ-XC01', 'YJ-XC02', 'YJ-XC03', 'YJ-XC04', 'YJ-XC05', 'YJ-XC06']);
  assert.deepEqual(rate('consignment', 'term_sheet'), {count: 8, advancedCount: 2, observedRateBps: 2500, status: 'insufficient', appliedRateBps: 3000});
  assert.deepEqual(rate('acquisition', 'rights_holder_meeting'), {count: 1, advancedCount: 1, observedRateBps: 10000, status: 'insufficient', appliedRateBps: 5000});
  // (4) 回収待ち（期待値の粗利が負）の製作委員会を源泉の偏りから除く。除かなければ製作委員会がいちばん足りない
  const a = b.awaitingExcluded;
  assert.deepEqual([a.awaitingExcluded, a.ratios.map((r) => r.source), a.mostShortSource, a.triggered, a.pick],
    [['committee'], ['contract_work', 'own_investment', 'acquisition', 'consignment'], 'consignment', true, {source: 'consignment', step: 'meeting', addCountX100: 100}]);
  assert.deepEqual(a.ratios, golden.proposals.shortfall.ratios.filter((r) => r.source !== 'committee'));
  const override = kpiSeed.branchCases.awaitingExcluded.overrides[0];
  const planCommittee = seed.計画.find((r) => r.期間 === '1年目' && r.版 === 2 && r.稼ぎ方 === '製作委員会')['計画額（円・税別）'];
  assert.ok(override.expectedYen < 0);
  assert.ok(Math.trunc((override.expectedSalesYen * 10000) / planCommittee) < Math.min(...a.ratios.map((r) => r.ratioBps)));
  // (5) 予定の払込（2027-02-10 の 12,000,000円）のある自社出資と製作委員会。払込は 2026-06-10 の 10,000,000円と期間内 2026-10-20 の 8,000,000円、
  // 収益は 2026-08 の 1,000,000円と 2026-11 の 4,000,000円（2026-12 は締めた月の後）。成立時の見込は 40,000,000円−予定の払込 12,000,000円
  const row = (key, code) => b.scheduledInvestment[key].rows.find((r) => r.projectCode === code);
  const cols = (r) => [r.investmentYen, r.revenueYen, r.periodInvestmentYen, r.periodRevenueYen, r.remainingExpectedYen, r.diffYen, r.recoveryRateBps, r.status, r.projectedDiffYen];
  assert.deepEqual(cols(row('standard', 'YJ-X41')), [30000000, 5000000, 8000000, 4000000, 40000000, -25000000, 1666, 'awaiting', 15000000]);
  assert.deepEqual(cols(row('standard', 'YJ-X42')), [18000000, 5000000, 8000000, 4000000, 28000000, -13000000, 2777, 'awaiting', 15000000]);
  // 悲観（回収の量 85%）: 自社出資は 40,000,000×85%＝34,000,000円、委員会は 34,000,000−12,000,000円
  assert.deepEqual([row('pessimistic', 'YJ-X41').remainingExpectedYen, row('pessimistic', 'YJ-X42').remainingExpectedYen], [34000000, 22000000]);
  // 同じ払込・同じ収益・同じ見込なら、出資額の取り方が違っても期末の見込みの差額は同じ（同じ払込を2回引かない）
  for (const key of SCENARIO_KEYS) assert.equal(row(key, 'YJ-X41').projectedDiffYen, row(key, 'YJ-X42').projectedDiffYen, key);
  assert.deepEqual(b.scheduledInvestment.standard.total, {rowCount: 2, investmentYen: 48000000, revenueYen: 10000000, diffYen: -38000000,
    periodInvestmentYen: 16000000, periodRevenueYen: 8000000, projectedDiffYen: 30000000, recoveryRateBps: 2083, status: 'awaiting'});
});

test('FR-REV-KPI-019 段B #9 #15: フェーズ1 #23a の行動の行を先に入れると、指標マスタの種の同じ変数×範囲の行は入らず、違う値の行は golden の skippedKpiMetricsSettings と同じ', async (t) => {
  const db = await openTestDb({t});
  const by = {createdBy: ADMIN};
  const earningCode = new Map((await planning.listEarningTypes(db)).map((e) => [e.label, e.code]));
  // 0.3 のような小数の率を、文字のまま bp に読む（浮動小数を掛けない）
  const bps = (v) => {
    const [whole, fraction = ''] = String(v).split('.');
    return Number(whole) * 10000 + Number(fraction.padEnd(4, '0'));
  };
  for (const r of seed.行動) {
    const earningType = earningCode.get(r.稼ぎ方);
    await store.addSettingVersion(db, 1, {variableKey: 'unit_amount', scope: 'earning_type', earningType, previousVersionNo: 0,
      value: {kind: 'yen', value: r['1件あたりの額（円・税別）']}, status: 'provisional', basis: r['1件あたりの中身']}, by);
    for (const [step, column] of [['meeting', '面談→提案の率'], ['proposal', '提案→契約の率']]) {
      await store.addSettingVersion(db, 1, {variableKey: 'conversion_rate', scope: 'earning_type_step', earningType, step, previousVersionNo: 0,
        value: {kind: 'bps', value: bps(r[column])}, status: 'provisional'}, by);
    }
  }
  const result = await seedKpiMetrics(db, {orgId: 1, createdBy: ADMIN});
  const skipped = golden.settings.skippedKpiMetricsSettings;
  const slot = (s) => [s.variableKey, s.scope, s.earningType ?? '', s.step ?? '', '', ''].join('|');
  assert.equal(result.settings.existing, skipped.length);
  assert.deepEqual([...result.settings.differing].sort(), skipped.filter((s) => !s.sameValue).map(slot).sort());
  // 残った1件の額はフェーズ1 #23a の行動の行の値で、golden の行動の1件の額と同じ
  const settings = await store.readEffectiveSettings(db, 1);
  for (const a of golden.inputs.actions) {
    assert.equal(settings.find((s) => s.variableKey === 'unit_amount' && s.earningType === a.source).value.value, a.dealYen, a.source);
  }
});

// 段A（core #109）の golden が同じ main に入ったあとで流れる。それまではこのブランチに test/fixtures/scenario/ が無いので飛ばす
const stageAFixture = fileURLToPath(new URL('./fixtures/scenario/compare-request.json', import.meta.url));
const stageAExpected = fileURLToPath(new URL('./fixtures/scenario/expected.json', import.meta.url));
const stageAReady = existsSync(stageAFixture) && existsSync(stageAExpected);
test('段B #15: 段A の golden と食い違わない（段A の入力をこの golden の計算に通すと、段A の golden の4つのシナリオ・効き・候補と同じ値）',
  {skip: stageAReady ? false : '段A（core #109）の test/fixtures/scenario/ がまだこのブランチに無い'}, () => {
    const fixture = JSON.parse(readFileSync(stageAFixture, 'utf8'));
    const a = JSON.parse(readFileSync(stageAExpected, 'utf8'));
    const inputs = inputsFromStageA(fixture, a);
    const keys = ['expectedYen', 'actualYen', 'weightedYen', 'actionYen', 'expectedSalesYen', 'actualSalesYen', 'weightedSalesYen', 'actionSalesYen'];
    for (const [key, g] of Object.entries(a.scenarios)) {
      const s = distOf(inputs, key);
      assert.deepEqual(Object.fromEntries(keys.map((k) => [k, s[k]])), Object.fromEntries(keys.map((k) => [k, g[k]])), key);
      assert.deepEqual(s.bySource, g.bySource, key);
      assert.deepEqual(s.act.map(({pNum, pExp, ...r}) => r), g.actionRows, key);
      assert.equal(1 + s.list.length, g.componentCount, key);
      assert.deepEqual(distributionPoints(s.dist), g.distribution.points, key);
      assert.deepEqual({p10Yen: quantileYen(s.dist, 1, 10), p50Yen: quantileYen(s.dist, 1, 2), p90Yen: quantileYen(s.dist, 9, 10)}, g.quantiles, key);
      assert.deepEqual(s.cash, g.cash, key);
    }
    assert.deepEqual(tornado(inputs), a.tornado);
    assert.deepEqual(candidateDeltas(inputs), a.candidates);
  });
