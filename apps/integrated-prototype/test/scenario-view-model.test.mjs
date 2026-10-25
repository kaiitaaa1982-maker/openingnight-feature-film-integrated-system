// シナリオの比較の画面が使う、応答から表示の形への変換と書式（src/revenue/scenario/scenario-view-model.mjs）を確かめる。
// 応答は、golden の入力（test/fixtures/scenario/compare-request.json）を計算の model に通して作る（DB は使わない）。API が付ける商談の一覧だけ、入力の商談から作る。
// 壊れたら: 出資の回収の差額・回収待ちの印が応答とずれる、目標に依る値が目標額なしの応答に出る・出るはずの応答に出ない、
// 確率の書式が境界（1%未満・99%超）で偽の 0%・100% を出す、画面が「読み終わった」印を古い応答に付ける。
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {normalizeCompareRequest, normalizeScenarioFacts} from '../src/revenue/scenario/scenario-inputs.mjs';
import {compareScenarios, SCENARIO_RANGES, GRID_YEN} from '../src/revenue/scenario/scenario-model.mjs';
import {
  yenText, signedYenText, percentText, probabilityText, pointText, monthJa, countText, hoursText, multiplierText, assumptionValueText,
  scenarioKeys, scenarioKpi, creatorsKpi, deltaFromStandard, movedAssumptions, movedActions, recoveryTable, sourceDetailRows, opportunityRows, actionActualRows,
  tornadoRows, candidateRows, reverseCards, distributionChart, noteChips, assumptionBounds, assumptionTicks, readyHash, SCENARIO_LABELS, RECOVERY_GROUPS,
} from '../src/revenue/scenario/scenario-view-model.mjs';

const fixture = JSON.parse(readFileSync(fileURLToPath(new URL('./fixtures/scenario/compare-request.json', import.meta.url)), 'utf8'));
function responseOf({targets = TARGETS, custom = true} = {}) {
  const body = {...structuredClone(fixture.request), targets};
  if (!targets) delete body.targets;
  if (!custom) delete body.custom;
  const request = normalizeCompareRequest(body);
  const facts = normalizeScenarioFacts(fixture.facts);
  const result = compareScenarios(request, facts);
  const titles = new Map([...(fixture.facts.ownInvestment ?? []), ...(fixture.facts.committee ?? []), ...(fixture.facts.consignment ?? [])].map((row) => [row.workId, row.title]));
  return {
    ...result,
    conditions: {period: request.period, closedMonth: request.closedMonth, actualWindow: {from: request.period.from, to: request.closedMonth}, basis: 'accrual', scope: {projectCount: 1, workCount: 1}},
    opportunityList: facts.opportunities.map((row) => ({...row, workTitle: titles.get(row.workId) ?? null})),
    workSources: [],
    demandCurve: {origin: 'release_month', throughMonth: request.closedMonth, workCount: 0, lineCount: 0, releaseSources: {window: 0, first_sale: 0, none: 0, after_close: 0}, channels: []},
    sourceHash: 'hash-of-this-response',
  };
}
const withoutTargets = responseOf({targets: null});
// 目標額は架空の値（fixture・golden には持たない）。目標額なしの応答の標準の分布（golden と同じ）から実行時に作り、10%点と90%点のあいだに置く（不規則な桁）。
// 分布の外に置くと、届く確率がどのシナリオでも 100% か 0% になり、確率の差・候補の前後・逆算の値が入れ替わっても試験が気づかない
const TARGETS = (({p10Yen, p50Yen}) => ({selfYen: p50Yen + 784321, companyYen: p10Yen + 951987}))(withoutTargets.scenarios.standard.quantiles);
const withTargets = responseOf();

test('書式: 値が無いときは0で埋めず、符号と桁区切りをそろえる（円・率・確率・確率の差・件数・時間・倍・月）', () => {
  assert.equal(yenText(null), '—');
  assert.equal(yenText(undefined, '未接続'), '未接続');
  assert.equal(yenText(0), '0円');
  assert.equal(yenText(-1234567), '-1,234,567円');
  assert.equal(signedYenText(0), '±0円');
  assert.equal(signedYenText(5), '+5円');
  assert.equal(signedYenText(-5), '-5円');
  assert.equal(signedYenText(null), '—');
  assert.equal(percentText(13030), '130.3%');
  assert.equal(percentText(0), '0%');
  assert.equal(percentText(null), '—');
  assert.equal(pointText(2000), '+20pt');
  assert.equal(pointText(-50), '-0.5pt');
  assert.equal(pointText(0), '±0pt');
  assert.equal(pointText(null), '—');
  assert.equal(monthJa('2026-09'), '2026年9月');
  assert.equal(monthJa(null), '—');
  assert.equal(countText(400), '4件');
  assert.equal(countText(150), '1.5件');
  assert.equal(countText(25), '0.25件');
  assert.equal(hoursText(4000), '40時間');
  assert.equal(multiplierText(195), '1.95倍');
  assert.equal(assumptionValueText('salesMultiplierBps', 11500), '115%');
  assert.equal(assumptionValueText('paymentDelayMonths', 1), '1か月');
});

test('確率の書式: ちょうど0と100以外は 0%・100% と書かない（1%未満・99%超は印で書く）。境界の両側', () => {
  const cases = [[0, '0%'], [1, '<1%'], [99, '<1%'], [100, '1%'], [149, '1%'], [150, '2%'], [1949, '19%'], [1950, '20%'], [5000, '50%'], [9900, '99%'], [9901, '>99%'], [9999, '>99%'], [10000, '100%']];
  for (const [bps, text] of cases) assert.equal(probabilityText(bps), text, `${bps}bp`);
  assert.equal(probabilityText(null), '—');
});

test('KPI: 期待値・内訳・目標との差は応答の値そのもの（画面で計算し直さない）。目標額なしの応答には目標に依る値が出ない', () => {
  const kpi = scenarioKpi(withTargets, 'standard');
  const s = withTargets.scenarios.standard;
  assert.equal(kpi.expectedYen, s.expectedYen);
  assert.equal(kpi.actualPlusWeightedYen, s.actualYen + s.weightedYen, '着地の代わり＝実績＋確度加重（行動からの見込を含まない）');
  assert.equal(kpi.expectedSalesYen, s.expectedSalesYen);
  assert.equal(kpi.self.targetYen, TARGETS.selfYen);
  assert.equal(kpi.self.gapYen, s.expectedYen - TARGETS.selfYen);
  assert.equal(kpi.company.gapYen, s.expectedYen - TARGETS.companyYen);
  assert.equal(kpi.self.reachBps, withTargets.targetView.self.scenarios.standard.reachBps);
  assert.deepEqual(kpi.quantiles, s.quantiles);
  assert.deepEqual(kpi.cash, s.cash);
  const none = scenarioKpi(withoutTargets, 'standard');
  assert.equal(none.self, null);
  assert.equal(none.company, null);
  assert.equal(none.expectedYen, withoutTargets.scenarios.standard.expectedYen, '目標額が無くても期待値と幅は出る');
  assert.equal(Object.hasOwn(withoutTargets, 'targetView'), false);
  // 目標が片方だけ
  const onlySelf = responseOf({targets: {selfYen: TARGETS.selfYen}});
  assert.equal(scenarioKpi(onlySelf, 'standard').company, null);
  assert.equal(scenarioKpi(onlySelf, 'standard').self.gapYen, s.expectedYen - TARGETS.selfYen);
});

test('試験の目標額は分布の中: 届く確率はどのシナリオでも 0% と 100% のあいだで、シナリオと行動の候補で動く。本人の目標の逆算は1倍より大きい', () => {
  // ここが崩れると（目標額が分布の外）、確率の差・候補の前後・逆算の値の取り違えを、ほかの試験が見分けられない
  for (const name of ['self', 'company']) {
    const view = withTargets.targetView[name];
    for (const key of scenarioKeys(withTargets)) {
      const bps = view.scenarios[key].reachBps;
      assert.ok(bps > 0 && bps < 10000, `${name} ${key}: ${bps}bp`);
    }
    assert.notEqual(view.scenarios.optimistic.reachBps, view.scenarios.standard.reachBps, `${name}: 楽観と標準の確率が違う`);
    assert.ok(view.candidates.some((row) => row.reachAfterBps !== row.reachBeforeBps), `${name}: 候補で確率が動く`);
  }
  const reverse = withTargets.targetView.self.reverse;
  assert.ok(reverse.expected.multiplierX100 > 100 && reverse.probability.multiplierX100 > reverse.expected.multiplierX100, JSON.stringify(reverse));
});

test('作り手・権利元へ渡る額は応答の値（販売委託の権利元の取り分の和）で、未接続なら null のまま', () => {
  assert.equal(creatorsKpi(withTargets).totalYen, 3600000);
  assert.equal(creatorsKpi(withTargets).unconnected, false);
  assert.equal(creatorsKpi(withTargets).mgReferenceYen, 1000000, '買付の MG は別の参考の値');
  const unconnected = {...withTargets, creators: {...withTargets.creators, totalYen: null, mgReferenceYen: null}};
  assert.equal(creatorsKpi(unconnected).unconnected, true);
  assert.equal(yenText(creatorsKpi(unconnected).totalYen, '未接続'), '未接続');
});

test('シナリオの比較: 標準との差は応答の値の差。標準の列には差を出さない。動かした前提と行動は標準と違うものだけ', () => {
  assert.deepEqual(scenarioKeys(withTargets), ['standard', 'optimistic', 'pessimistic', 'custom']);
  assert.deepEqual(scenarioKeys(responseOf({custom: false})), ['standard', 'optimistic', 'pessimistic']);
  assert.equal(deltaFromStandard(withTargets, 'standard'), null);
  const delta = deltaFromStandard(withTargets, 'optimistic');
  assert.equal(delta.expectedYen, withTargets.scenarios.optimistic.expectedYen - withTargets.scenarios.standard.expectedYen);
  assert.equal(delta.reachSelfBps, withTargets.targetView.self.scenarios.optimistic.reachBps - withTargets.targetView.self.scenarios.standard.reachBps);
  assert.equal(delta.reachCompanyBps, withTargets.targetView.company.scenarios.optimistic.reachBps - withTargets.targetView.company.scenarios.standard.reachBps);
  assert.equal(deltaFromStandard(withTargets, 'pessimistic').reachSelfBps, withTargets.targetView.self.scenarios.pessimistic.reachBps - withTargets.targetView.self.scenarios.standard.reachBps);
  assert.equal(deltaFromStandard(withoutTargets, 'optimistic').reachSelfBps, null, '目標額なしでは確率の差を出さない');
  // 楽観・悲観は市場の前提のうち4つだけを動かす（面談→提案の率は動かさない）
  assert.deepEqual(movedAssumptions(withTargets, 'optimistic').map((row) => row.key), ['salesMultiplierBps', 'recoveryAmountBps', 'proposalToContractBps']);
  assert.deepEqual(movedAssumptions(withTargets, 'pessimistic').map((row) => row.key), ['salesMultiplierBps', 'recoveryAmountBps', 'proposalToContractBps', 'paymentDelayMonths']);
  assert.deepEqual(movedAssumptions(withTargets, 'standard'), []);
  assert.deepEqual(movedAssumptions(withTargets, 'custom').map((row) => `${row.label} ${row.text}`), ['提案→契約の率 35%']);
  assert.deepEqual(movedActions(withTargets, 'custom').map((row) => `${row.label} ${row.text}`), ['販売委託の面談 6件']);
  assert.deepEqual(movedActions(withTargets, 'standard'), []);
  assert.deepEqual(scenarioKpi(withTargets, 'custom').moved, ['提案→契約の率 35%', '販売委託の面談 6件']);
});

test('出資の回収: 行は自社出資・製作委員会の順にまとめ、差額＝収益−出資額。負の行は回収待ち、0以上は回収済み。合計とシナリオごとの期末の見込みの差額は応答の値', () => {
  const table = recoveryTable(withTargets);
  const standard = withTargets.scenarios.standard.investmentRecovery;
  assert.deepEqual(table.groups.map((group) => group.kind), RECOVERY_GROUPS.map((group) => group.kind));
  const rows = table.groups.flatMap((group) => group.rows);
  assert.equal(rows.length, standard.rows.length);
  for (const row of rows) {
    if (row.diffYen !== null) assert.equal(row.diffYen, row.revenueYen - row.investmentYen, row.title);
    assert.equal(row.statusLabel, row.diffYen === null ? '未確定' : row.diffYen < 0 ? '回収待ち' : '回収済み', row.title);
    assert.equal(row.recoveryRateBps === null, row.diffYen === null || !(row.investmentYen > 0), `${row.title}: 出資額が無い・0円の行は回収率を出さない`);
  }
  // 自社出資の行: 出資額＝作品マスタの値、収益＝作品単位の入金。出資額0の行（委員会の払込が無い行）は回収率が null
  const own = table.groups.find((group) => group.kind === 'own_investment').rows[0];
  assert.deepEqual([own.investmentYen, own.revenueYen, own.diffYen], [4000000, 2200000, -1800000]);
  assert.equal(own.statusLabel, '回収待ち');
  assert.equal(own.recoveryRateBps, 5500);
  const noPayment = rows.find((row) => row.title === '夜の温室（架空）');
  assert.equal(noPayment.investmentYen, 0);
  assert.equal(noPayment.recoveryRateBps, null, '出資額0円の行は0%で埋めない');
  assert.equal(noPayment.statusLabel, '回収済み');
  // 期末の見込みの差額（シナリオごと）: 標準の行は 差額＋残りの期待値
  for (const key of table.keys) {
    for (const row of rows) {
      const expected = withTargets.scenarios[key].investmentRecovery.rows.find((r) => `${r.kind}:${r.workId}` === row.key).projectedDiffYen;
      assert.equal(row.projectedYen[key], expected, `${key} ${row.title}`);
    }
    assert.equal(table.total.projectedYen[key], withTargets.scenarios[key].investmentRecovery.total.projectedDiffYen, `${key} の合計`);
  }
  assert.equal(table.total.diffYen, standard.total.diffYen);
  assert.equal(table.total.statusLabel, standard.total.status === 'awaiting' ? '回収待ち' : '回収済み');
  // 収益の基準の印: 自社出資は税込（作品の入金）、製作委員会は計上（自社の取得額）。合計は両方の行を足すので混在
  assert.deepEqual([...new Set(rows.map((row) => `${row.kind}:${row.basis}`))].sort(), ['committee:計上', 'own_investment:税込']);
  assert.equal(table.total.basis, '税込と計上の混在');
  // 合計に入る行が1種類だけなら、その基準
  const ownOnly = recoveryTable({...withTargets, scenarios: Object.fromEntries(Object.entries(withTargets.scenarios).map(([key, s]) => [key, {...s, investmentRecovery: {...s.investmentRecovery,
    rows: s.investmentRecovery.rows.filter((row) => row.kind === 'own_investment')}}]))});
  assert.equal(ownOnly.total.basis, '税込');
  // 保留・誤りの注記は行に添える（誤りの行は金額を 0 にせず未確定）
  const errored = rows.find((row) => row.note && row.noteIsError);
  assert.equal(errored.diffYen, null);
  assert.equal(errored.statusLabel, '未確定');
  assert.match(rows.find((row) => row.note && !row.noteIsError).note, /保留/);
  // 差額が分からない行は合計に入れず、件数を出す
  assert.equal(table.unknown.count, 1);
  assert.deepEqual(table.unconnected, []);
});

test('出資の回収: 委員会の源泉が未接続なら、行を作らず名前を出す（0円の行で埋めない）', () => {
  const facts = normalizeScenarioFacts({...fixture.facts, committee: null});
  const response = {...withTargets, ...compareScenarios(normalizeCompareRequest({...fixture.request, targets: TARGETS}), facts)};
  const table = recoveryTable(response);
  assert.deepEqual(table.unconnected, ['製作委員会']);
  assert.deepEqual(table.groups.map((group) => group.kind), ['own_investment']);
});

test('稼ぎ方別の明細: 源泉が未接続の行は実績を null のまま（理由の語を出す）。期待値は応答の内訳の和', () => {
  const rows = sourceDetailRows(withTargets);
  const work = rows.find((row) => row.source === 'contract_work');
  assert.equal(work.status, 'unconnected');
  assert.equal(work.actualYen, null);
  for (const key of ['standard', 'optimistic', 'pessimistic', 'custom']) {
    assert.equal(rows.reduce((n, row) => n + (row.expectedYen[key] ?? 0), 0), withTargets.scenarios[key].expectedYen, `${key} の合計＝期待値（配らない）`);
  }
});

test('商談の明細: 期待値に入れた商談と、入れていない商談（失注・源泉の指定なし・見込額なし）を理由つきで分ける。行動の実績は応答の件数', () => {
  const {included, excluded} = opportunityRows(withTargets);
  assert.equal(included.length + excluded.length, withTargets.opportunityList.length);
  assert.deepEqual(excluded.map((row) => [row.id, row.reasonLabel]).sort((a, b) => a[0] - b[0]), [[6, '失注'], [7, '見込額なし'], [8, '源泉の指定なし']]);
  const overdue = included.find((row) => row.id === 1);
  assert.equal(overdue.overdue, true, '成約日の月が締めた月以前の商談は、次の月に立つとみなした印を出す');
  const actual = actionActualRows(withTargets);
  assert.equal(actual.reduce((n, row) => n + row.contract, 0), withTargets.actionActuals.total.contract);
});

test('前提の効き: 棒は標準からの期待値の差。期待値が下がる側は左、上がる側は右。幅は最大の動きを 50% とした割合', () => {
  const rows = tornadoRows(withTargets);
  assert.equal(rows.length, withTargets.tornado.length);
  const standardYen = withTargets.scenarios.standard.expectedYen;
  for (const [index, row] of rows.entries()) {
    const source = withTargets.tornado[index];
    assert.equal(row.pessimistic.deltaYen, source.pessimistic.expectedYen - standardYen);
    assert.equal(row.optimistic.deltaYen, source.optimistic.expectedYen - standardYen);
    for (const bar of row.bars) {
      assert.equal(bar.direction, bar.deltaYen < 0 ? 'left' : 'right');
      assert.ok(bar.widthPct >= 0 && bar.widthPct <= 50, `${row.label} ${bar.side} ${bar.widthPct}`);
    }
  }
  assert.equal(Math.max(...rows.flatMap((row) => row.bars.map((bar) => bar.widthPct))), 50, '最大の動きの棒は 50%');
  assert.ok(rows.slice(0, 3).every((row) => row.check), '上位3つは確かめる手段つき');
  assert.ok(rows.slice(3).every((row) => !row.check));
  // 入金の遅れ: 標準0・楽観0・悲観1 のとき、楽観の側は動かない（幅0の棒）
  const delay = rows.find((row) => row.key === 'paymentDelayMonths');
  assert.equal(delay.optimistic.text, '0か月');
  assert.equal(delay.bars.find((bar) => bar.side === 'optimistic').widthPct, 0);
});

test('行動の候補: 目標額があれば目標の確率の前後を添え、並びは応答の順（目標（本人）の1時間あたりの確率の増分の順）。目標額なしは期待値の増分の順', () => {
  const rows = candidateRows(withTargets);
  assert.deepEqual(rows.map((row) => row.key), withTargets.targetView.self.candidates.map((row) => `${row.source}:${row.step}`));
  for (const row of rows) {
    const self = withTargets.targetView.self.candidates.find((c) => `${c.source}:${c.step}` === row.key);
    assert.deepEqual([row.targets.self.beforeBps, row.targets.self.afterBps, row.targets.self.deltaBps], [self.reachBeforeBps, self.reachAfterBps, self.reachDeltaBps]);
    assert.equal(row.perHourYen, Number(BigInt(row.expectedDeltaYen * 100) / BigInt(row.hoursX100)), '1時間あたり（切り捨て）');
  }
  const plain = candidateRows(withoutTargets);
  assert.deepEqual(plain.map((row) => row.key), withoutTargets.candidates.map((row) => `${row.source}:${row.step}`));
  assert.deepEqual(plain.map((row) => Object.keys(row.targets)), plain.map(() => []), '目標額なしでは確率を出さない');
  // 時間0の行動は 1時間あたりを出さない（0 で割らない）
  const zero = {...withoutTargets, candidates: withoutTargets.candidates.map((row, i) => (i === 0 ? {...row, hoursX100: 0} : row))};
  assert.equal(candidateRows(zero).find((row) => row.hoursX100 === 0).perHourYen, null);
});

test('逆算: 目標ごとに、期待値で届く倍率と確率70%に届く倍率（届かなければ null）と、固定した行動の理由。目標額なしでは出ない', () => {
  assert.deepEqual(reverseCards(withoutTargets), []);
  const cards = reverseCards(withTargets);
  assert.deepEqual(cards.map((card) => card.name), ['self', 'company']);
  for (const card of cards) {
    const view = withTargets.targetView[card.name].reverse;
    assert.equal(card.targetYen, withTargets.targetView[card.name].targetYen);
    assert.equal(card.expected?.multiplierX100 ?? null, view.expected?.multiplierX100 ?? null);
    assert.equal(card.probability?.multiplierX100 ?? null, view.probability?.multiplierX100 ?? null);
    assert.equal(card.fixed.length, view.fixed.length);
  }
  // 固定した行動には理由の語を添える
  const withFixed = {...withTargets, targetView: {...withTargets.targetView, self: {...withTargets.targetView.self,
    reverse: {...withTargets.targetView.self.reverse, fixed: [{source: 'acquisition', step: 'meeting', reason: 'flat'}, {source: 'consignment', step: 'meeting', reason: 'down'}], stopped: {multiplierX100: 250, reason: 'request_limit'}}}}};
  const card = reverseCards(withFixed)[0];
  assert.deepEqual(card.fixed.map((row) => row.reason), ['増やしても今期は変わらない', '増やすと今期は下がる']);
  assert.equal(card.stopped.multiplierX100, 250);
});

test('分布のグラフ: 区間ごとの確率の和は1、目標の縦線は応答の目標額の位置、軸の目盛りは範囲の中に収まる。目標額なしは縦線なし', () => {
  const chart = distributionChart(withTargets);
  const keys = scenarioKeys(withTargets);
  assert.deepEqual(chart.lines.map((line) => line.key), keys);
  assert.equal(chart.binYen % GRID_YEN, 0, '区間は1万円の格子の倍数');
  for (const line of chart.lines) assert.equal(line.points.split(' ').length, chart.lines[0].points.split(' ').length, '全シナリオで区間の数が同じ');
  assert.deepEqual(chart.targets.map((target) => [target.name, target.yen]), [['self', TARGETS.selfYen], ['company', TARGETS.companyYen]]);
  for (const target of chart.targets) assert.ok(target.x >= chart.plot.left && target.x <= chart.plot.right, target.label);
  // 本人の目標（大きい額）は会社の目標より右
  assert.ok(chart.targets[0].x > chart.targets[1].x);
  for (const tick of chart.xTicks) assert.ok(tick.x >= chart.plot.left - 0.1 && tick.x <= chart.plot.right + 0.1, tick.label);
  assert.ok(chart.xTicks.length >= 2);
  assert.deepEqual(chart.xTicks.map((tick) => tick.yen), [...chart.xTicks.map((tick) => tick.yen)].sort((a, b) => a - b));
  assert.equal(distributionChart(withoutTargets).targets.length, 0);
  // 折れ線の y は確率の大きいほど上（SVG の座標は下向き）。確率の最大の点が plot の上端
  const ys = chart.lines.flatMap((line) => line.points.split(' ').map((p) => Number(p.split(',')[1])));
  assert.equal(Math.min(...ys), chart.plot.top);
  assert.ok(Math.max(...ys) <= chart.plot.bottom);
});

test('分布のグラフ: 目標の線が近いと、右の見出しを図の中の1段下に左寄せで置き、2つの見出しが重ならない。離れていれば両方とも線の真上', () => {
  const near = {...withTargets, targetView: {...withTargets.targetView, company: {...withTargets.targetView.company, targetYen: withTargets.targetView.self.targetYen - 10000}}};
  const chart = distributionChart(near);
  const [left, right] = [...chart.targets].sort((a, b) => a.x - b.x);
  assert.ok(right.x - left.x < 90, '線は近い');
  assert.deepEqual([left.labelY, left.labelAnchor, left.labelX], [chart.plot.top - 8, 'middle', left.x]);
  assert.deepEqual([right.labelY, right.labelAnchor, right.labelX], [chart.plot.top + 12, 'start', right.x + 4]);
  const far = distributionChart(withTargets);
  if (Math.abs(far.targets[0].x - far.targets[1].x) >= 90) {
    for (const target of far.targets) assert.deepEqual([target.labelY, target.labelAnchor], [far.plot.top - 8, 'middle']);
  }
});

test('分布のグラフ: 区間に分けても、各シナリオの確率の和は1のまま（落とさず重ねない）。額は区間の始まりから数える', () => {
  const sumOf = (bins) => bins.reduce((n, p) => n + p, 0);
  const chart = distributionChart(withTargets);
  for (const line of chart.lines) assert.ok(Math.abs(sumOf(line.bins) - 1) < 1e-9, `${line.key} の和 ${sumOf(line.bins)}`);
  // 応答の点と区間の対応: どの点も、始まり＋区間の幅×番号 の区間に入る
  for (const [index, line] of chart.lines.entries()) {
    const points = withTargets.scenarios[line.key].distribution.points;
    const expected = new Array(line.bins.length).fill(0);
    for (const [yen, p] of points) expected[(yen - chart.binStartYen - ((yen - chart.binStartYen) % chart.binYen)) / chart.binYen] += p;
    assert.deepEqual(line.bins, expected, `${chart.lines[index].key}`);
  }
  // 1点だけの分布（確率1。負の額）と、範囲の外の目標でも、区間の位置が配列の外に出ない
  const only = (points) => ({...withTargets, scenarios: Object.fromEntries(Object.entries(withTargets.scenarios).map(([key, s]) => [key, {...s, distribution: {gridYen: GRID_YEN, points}}]))});
  const one = distributionChart(only([[-5430000, 1]]));
  assert.equal(one.lines.length, 4);
  assert.ok(one.targets.every((target) => Number.isFinite(target.x)));
  for (const line of one.lines) {
    assert.ok(line.points.split(' ').every((p) => p.split(',').every((n) => Number.isFinite(Number(n)))));
    assert.equal(sumOf(line.bins), 1);
    // 負の額の区間: -5,430,000 を含む区間の始まりは、額以下で最大の（区間の幅の倍数＋始まり）
    const at = line.bins.findIndex((p) => p === 1);
    assert.ok(one.binStartYen + at * one.binYen <= -5430000 && -5430000 < one.binStartYen + (at + 1) * one.binYen);
  }
  // 同じ区間に入る2点は足す
  const two = distributionChart(only([[0, 0.25], [10000, 0.75]]));
  assert.equal(sumOf(two.lines[0].bins), 1);
});

test('分布のグラフ: 点が30万個ある分布でも描ける（引数に展開しない）。確率の和は1', () => {
  const n = 300000;
  const points = Array.from({length: n}, (_, i) => [(i - 100000) * GRID_YEN, 1 / n]);
  const big = {...withTargets, scenarios: Object.fromEntries(Object.entries(withTargets.scenarios).map(([key, s]) => [key, {...s, distribution: {gridYen: GRID_YEN, points}}]))};
  const chart = distributionChart(big);
  assert.ok(Math.abs(chart.lines[0].bins.reduce((sum, p) => sum + p, 0) - 1) < 1e-6);
  assert.ok(chart.lines[0].bins.length <= 80, `区間は ${chart.lines[0].bins.length} 個（区間の幅は範囲を36ほどに分ける）`);
});

test('注記の帯: 応答の注記から短い語を作る（仮置き・税込・未接続・未確定・MG 残・未紐付け N件・買付候補の面談）。保存・採用なしを常に添える', () => {
  const labels = noteChips(withTargets).map((chip) => chip.label);
  assert.ok(labels.includes('確度と率は仮置き'));
  assert.ok(labels.includes('入金は税込・未確定（参考）'));
  assert.ok(labels.includes('制作受託は未接続（0円で埋めない）'));
  assert.ok(labels.includes('MG 残は未控除'));
  assert.ok(labels.includes('未紐付けの報告 1件'));
  assert.ok(labels.includes('買付候補の面談は数えていない'));
  assert.ok(labels.includes('保存・採用なし（要求の本文で計算）'));
  assert.equal(new Set(labels).size, labels.length, '同じ語を2回出さない');
  // 応答に無い注記は出さない（未紐付けの報告が0件なら出ない）
  const clean = {...withTargets, notes: withTargets.notes.filter((note) => note.code !== 'unlinked'), unlinkedReports: {count: 0, amountYen: 0}};
  assert.ok(!noteChips(clean).some((chip) => /未紐付け/.test(chip.label)));
});

test('スライダーの範囲と目盛り: 標準を中心に楽観・悲観の幅の3倍まで（モデルの下限・上限に収める）。目盛りは前提の効きと同じ幅', () => {
  assert.deepEqual(assumptionBounds('salesMultiplierBps', 10000), {min: 5500, max: 14500, step: 100});
  assert.deepEqual(assumptionBounds('proposalToContractBps', 3000), {min: 0, max: 6000, step: 100});
  assert.deepEqual(assumptionBounds('proposalToContractBps', 9000), {min: 6000, max: 10000, step: 100}, '率は100%を超えない');
  assert.deepEqual(assumptionBounds('paymentDelayMonths', 0), {min: SCENARIO_RANGES.paymentDelayMonths.min, max: SCENARIO_RANGES.paymentDelayMonths.max, step: 1});
  assert.deepEqual(assumptionTicks('salesMultiplierBps', 10000), {pessimistic: 8500, standard: 10000, optimistic: 11500});
  assert.deepEqual(assumptionTicks('meetingToProposalBps', 5000), {pessimistic: 4000, standard: 5000, optimistic: 6000});
  assert.deepEqual(assumptionTicks('paymentDelayMonths', 0), {pessimistic: 1, standard: 0, optimistic: 0});
  assert.deepEqual(assumptionTicks('proposalToContractBps', 500), {pessimistic: 0, standard: 500, optimistic: 1500}, '下限で止める');
});

test('data-ready: 画面が読んだ応答の sourceHash と一致したときだけ hash を返す。送信中・誤り・入力が変わった後・描き終える前は null', () => {
  const shown = {response: {sourceHash: 'abc'}, signature: 'sig-1'};
  const base = {shown, renderedHash: 'abc', loading: false, error: null, signature: 'sig-1'};
  assert.equal(readyHash(base), 'abc');
  assert.equal(readyHash({...base, shown: null}), null, '応答が無い');
  assert.equal(readyHash({...base, renderedHash: null}), null, '応答を描き終える前');
  assert.equal(readyHash({...base, renderedHash: 'old'}), null, '描いたのは別の応答（hash が違う）');
  assert.equal(readyHash({...base, loading: true}), null, '送信中');
  assert.equal(readyHash({...base, error: new Error('x')}), null, '誤り');
  assert.equal(readyHash({...base, signature: 'sig-2'}), null, '入力が変わった（表示中の応答は今の入力のものでない）');
  assert.equal(readyHash({...base, signature: null}), null, '入力に誤りがある（本文を作れない）');
  assert.equal(readyHash({...base, shown: {response: {sourceHash: ''}, signature: 'sig-1'}, renderedHash: ''}), null, '空の hash は印にしない');
});

test('シナリオの名前は標準・楽観・悲観・カスタム（採用中の語を使わない。段A に採用は無い）', () => {
  assert.deepEqual(Object.values(SCENARIO_LABELS), ['標準', '楽観', '悲観', 'カスタム']);
});
