// シナリオの比較の画面の入力（src/revenue/scenario/scenario-form-model.mjs）を確かめる。画面は入力の文字から毎回、要求の本文を作って送る。
// 壊れたら: 画面の既定の前提が golden の入力とずれて（A-5 の照合が合わなくなる）、入力の文字が整数に直らず 0 で埋まる、
// 目標額が空でも本文に載る・目標額の誤りが黙って通る、カスタムが標準を書き換える。
// 期待値は golden の入力（test/fixtures/scenario/compare-request.json の request）と、計画の A-3 から持ってくる。
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {normalizeCompareRequest} from '../src/revenue/scenario/scenario-inputs.mjs';
import {
  FORM_DEFAULTS, initialForm, defaultPeriod, buildCompareRequest, requestSignature, decimalX100, x100Text, defaultOpportunitySpecs, channelGapsFor, withDiscovery,
  setIn, chooseOpportunitySource, addToCustom, removeFromCustom, customCountOf, resetCustom, customIsEmpty, hasTargets, UNKNOWN_CHANNEL_GAP_MONTHS,
} from '../src/revenue/scenario/scenario-form-model.mjs';

const fixture = JSON.parse(readFileSync(fileURLToPath(new URL('./fixtures/scenario/compare-request.json', import.meta.url)), 'utf8'));
const form = (patch = {}) => ({...initialForm({currentMonth: '2026-10', fiscalStartMonth: 4}), ...patch});
const built = (f) => buildCompareRequest(f);
const errorFields = (f) => buildCompareRequest(f).errors?.map((error) => error.field) ?? [];

test('画面の既定の前提は golden の入力と同じ値（確度・窓口別の支払いの間・市場の前提・標準の行動）', () => {
  const request = fixture.request;
  assert.deepEqual(FORM_DEFAULTS.stageProbabilityBps, request.stageProbabilityBps);
  assert.deepEqual(FORM_DEFAULTS.paymentGapMonths, request.paymentGapMonths);
  assert.deepEqual(FORM_DEFAULTS.assumptions, request.assumptions);
  assert.deepEqual(FORM_DEFAULTS.actions, request.actions);
  // 既定の入力から作った本文は、期間・締めた月・商談・カスタムを除いて golden の入力と同じ
  const body = built(form()).body;
  for (const key of ['stageProbabilityBps', 'paymentGapMonths', 'assumptions', 'actions']) assert.deepEqual(body[key], request[key], key);
});

test('画面の入力（golden の商談の指定とカスタム）から作った要求の本文は、golden の入力の本文と一致する', () => {
  const request = fixture.request;
  const f = form({
    period: request.period, closedMonth: request.closedMonth,
    opportunities: request.opportunities.map((row) => ({id: row.id, source: row.source, conversionPct: String(row.conversionBps / 100), revenueMonth: row.revenueMonth ?? ''})),
    custom: {assumptions: {proposalToContractBps: '35'}, actions: {'consignment:meeting': '6'}},
  });
  const result = built(f);
  assert.equal(result.ok, true, JSON.stringify(result.errors));
  assert.deepEqual(result.body, request);
  // サーバーと同じ検査を通る
  assert.doesNotThrow(() => normalizeCompareRequest(result.body));
});

test('期間と締めた月の既定: 今月を含む年度と、その前の月（期間を出ない）。年度の最初の月は締めた月が期間の前になる', () => {
  assert.deepEqual(defaultPeriod('2026-10', 4), {from: '2026-04', to: '2027-03', closedMonth: '2026-09'});
  assert.deepEqual(defaultPeriod('2026-10', 5), {from: '2026-05', to: '2027-04', closedMonth: '2026-09'});
  assert.deepEqual(defaultPeriod('2026-04', 4), {from: '2026-04', to: '2027-03', closedMonth: '2026-03'});
  assert.deepEqual(defaultPeriod('2027-03', 4), {from: '2026-04', to: '2027-03', closedMonth: '2027-02'});
  assert.deepEqual(defaultPeriod('2027-04', 4), {from: '2027-04', to: '2028-03', closedMonth: '2027-03'});
  // 期首の設定が無いときは組織の既定（5月）
  assert.equal(defaultPeriod('2026-10').from, '2026-05');
  // 締めた月が期間の前でも、本文は作れる（実績の範囲が空になるだけ）
  assert.equal(built(initialForm({currentMonth: '2026-04', fiscalStartMonth: 4})).ok, true);
});

test('件数・時間の文字は小数2桁までを ×100 の整数に直す（小数の計算を通さない）。読めない文字は null', () => {
  assert.equal(decimalX100('4'), 400);
  assert.equal(decimalX100('1.5'), 150);
  assert.equal(decimalX100('0.04'), 4);
  assert.equal(decimalX100('１２．２５'), 1225);
  assert.equal(decimalX100('3件'), 300);
  assert.equal(decimalX100('0.005'), null, '3桁目は読まない');
  assert.equal(decimalX100('-1'), null);
  assert.equal(decimalX100(''), null);
  assert.equal(decimalX100('abc'), null);
  assert.equal(x100Text(400), '4');
  assert.equal(x100Text(150), '1.5');
  assert.equal(x100Text(4), '0.04');
  assert.equal(x100Text(1225), '12.25');
  assert.equal(decimalX100(x100Text(1225)), 1225);
});

test('読めない入力は0で埋めず、どの項目かを添えて返す（確度・前提・行動・月・目標額）', () => {
  const f = form();
  assert.deepEqual(errorFields(setIn(f, ['stageProbabilityPct', 'lead'], 'abc')), ['stageProbabilityBps.lead']);
  assert.deepEqual(errorFields(setIn(f, ['stageProbabilityPct', 'lead'], '100.01')), ['stageProbabilityBps.lead'], '100%を超える確度');
  assert.deepEqual(errorFields(setIn(f, ['assumptions', 'paymentDelayMonths'], '7')), ['assumptions.paymentDelayMonths'], '入金の遅れは6か月まで');
  assert.deepEqual(errorFields(setIn(f, ['assumptions', 'salesMultiplierBps'], '')), ['assumptions.salesMultiplierBps']);
  assert.deepEqual(errorFields(setIn(f, ['actions', 0, 'count'], '1.234')), ['actions[0].countX100']);
  assert.deepEqual(errorFields(setIn(f, ['actions', 1, 'dealYen'], '1.5')), ['actions[1].dealYen'], '円は整数');
  assert.deepEqual(errorFields(setIn(f, ['period', 'from'], '2026年')), ['period.from']);
  assert.deepEqual(errorFields(setIn(f, ['closedMonth'], '')), ['closedMonth']);
  assert.deepEqual(errorFields(setIn(f, ['targets', 'selfYen'], '0')), ['targets.selfYen']);
  assert.deepEqual(errorFields(setIn(f, ['targets', 'companyYen'], 'abc')), ['targets.companyYen']);
  assert.deepEqual(errorFields(setIn(f, ['custom', 'actions', 'consignment:meeting'], 'x')), ['custom.actions.consignment:meeting']);
  assert.deepEqual(errorFields(setIn(f, ['custom', 'assumptions', 'proposalToContractBps'], '101')), ['custom.assumptions.proposalToContractBps']);
  // 誤りがあれば本文は返さない
  assert.equal(buildCompareRequest(setIn(f, ['stageProbabilityPct', 'lead'], 'abc')).body, undefined);
  // 本文の側の検査（期間の終わりが始まりより前）も、サーバーと同じ検査で止める
  const reversed = buildCompareRequest(setIn(setIn(f, ['period', 'from'], '2027-04'), ['period', 'to'], '2026-04'));
  assert.equal(reversed.ok, false);
  assert.equal(reversed.errors[0].field, 'period.to');
  // 誤りの文は日本語で、項目の名前を含む
  assert.match(buildCompareRequest(setIn(f, ['stageProbabilityPct', 'lead'], 'abc')).errors[0].message, /確度（見込み）/);
});

test('全角・桁区切り・円・単位つきの入力を吸収する（目標額・1件の額・件数）', () => {
  const f = setIn(setIn(setIn(form(), ['targets', 'selfYen'], '１２，３４５，０００円'), ['actions', 0, 'dealYen'], '¥7,025,000'), ['actions', 0, 'count'], '４件');
  const {ok, body} = built(f);
  assert.equal(ok, true);
  assert.equal(body.targets.selfYen, 12345000);
  assert.equal(body.actions[0].dealYen, 7025000);
  assert.equal(body.actions[0].countX100, 400);
});

test('目標額は、入れた側だけが本文に載る。両方空なら targets の項目ごと送らない', () => {
  assert.equal(Object.hasOwn(built(form()).body, 'targets'), false);
  assert.equal(hasTargets(form()), false);
  const self = built(setIn(form(), ['targets', 'selfYen'], '12,345,000'));
  assert.deepEqual(self.body.targets, {selfYen: 12345000});
  const company = built(setIn(form(), ['targets', 'companyYen'], '8765000'));
  assert.deepEqual(company.body.targets, {companyYen: 8765000});
  const both = built(setIn(setIn(form(), ['targets', 'selfYen'], '1'), ['targets', 'companyYen'], '2'));
  assert.deepEqual(both.body.targets, {selfYen: 1, companyYen: 2});
  assert.equal(hasTargets(setIn(form(), ['targets', 'selfYen'], '1')), true);
  // 目標額だけを変えると本文の鍵が変わる（計算し直す）。変えなければ同じ（同じ入力では送り直さない）
  assert.notEqual(requestSignature(self.body), requestSignature(built(form()).body));
  assert.equal(requestSignature(built(form()).body), requestSignature(built(form()).body));
});

test('商談ごとの指定: 稼ぎ方が空の商談は本文に入れない。換算率と売上の月を直せる。稼ぎ方を替えたら換算率は仮置きに戻る', () => {
  const list = [{id: 1, workId: 10, partnerKind: 'platform'}, {id: 2, workId: 11, partnerKind: 'retailer'}, {id: 3, workId: 12, partnerKind: 'other'}, {id: 4, workId: 13, partnerKind: 'agency'}];
  const sources = [{workId: 10, sources: ['consignment']}, {workId: 11, sources: ['own_investment', 'acquisition']}, {workId: 12, sources: []}];
  const specs = defaultOpportunitySpecs(list, sources);
  assert.deepEqual(specs, [
    {id: 1, source: 'consignment', conversionPct: '20', revenueMonth: ''},
    {id: 2, source: '', conversionPct: '', revenueMonth: ''},
    {id: 3, source: '', conversionPct: '', revenueMonth: ''},
    {id: 4, source: '', conversionPct: '', revenueMonth: ''},
  ]);
  const f = {...form(), opportunities: specs};
  assert.deepEqual(built(f).body.opportunities, [{id: 1, source: 'consignment', conversionBps: 2000}]);
  const edited = chooseOpportunitySource(f, 2, 'acquisition');
  assert.deepEqual(edited.opportunities[1], {id: 2, source: 'acquisition', conversionPct: '100', revenueMonth: ''});
  const withMonth = setIn(edited, ['opportunities', 1, 'revenueMonth'], '2027-03');
  assert.deepEqual(built(withMonth).body.opportunities, [
    {id: 1, source: 'consignment', conversionBps: 2000}, {id: 2, source: 'acquisition', conversionBps: 10000, revenueMonth: '2027-03'}]);
  // 指定を外すと、また本文に入らない
  assert.deepEqual(built(chooseOpportunitySource(withMonth, 2, '')).body.opportunities, [{id: 1, source: 'consignment', conversionBps: 2000}]);
  // 商談を読む前（opportunities が null）は空の指定
  assert.deepEqual(built(form()).body.opportunities, []);
  // 換算率が読めなければ、その商談の項目で止める
  assert.deepEqual(errorFields(setIn(f, ['opportunities', 0, 'conversionPct'], '120')), ['opportunities.1.conversionBps']);
});

test('窓口別の支払いの間: 商談に出てくる取引先の種類で、既定に無い種類は仮置き1か月で足す（入金の月を決められない商談を作らない）', () => {
  const gaps = channelGapsFor([{partnerKind: 'platform'}, {partnerKind: 'vendor'}, {partnerKind: null}], {platform: '2'});
  assert.deepEqual(gaps, {platform: '2', vendor: String(UNKNOWN_CHANNEL_GAP_MONTHS)});
  const base = form();
  const next = withDiscovery(base, {opportunityList: [{id: 1, workId: 10, partnerKind: 'cinema'}], workSources: [{workId: 10, sources: ['committee']}]});
  assert.equal(next.paymentGapMonths.cinema, '1');
  assert.equal(next.paymentGapMonths.platform, '2');
  assert.deepEqual(next.opportunities, [{id: 1, source: 'committee', conversionPct: '100', revenueMonth: ''}]);
  assert.equal(buildCompareRequest(next).ok, true);
});

test('カスタムは標準から動かした値だけを持ち、標準の入力を書き換えない。標準に戻すと本文のカスタムは空になる', () => {
  const f = form();
  const moved = setIn(setIn(f, ['custom', 'assumptions', 'paymentDelayMonths'], '2'), ['custom', 'actions', 'acquisition:meeting'], '3');
  const {body} = built(moved);
  assert.deepEqual(body.custom, {assumptions: {paymentDelayMonths: 2}, actions: [{source: 'acquisition', step: 'meeting', countX100: 300}]});
  assert.deepEqual(body.assumptions, fixture.request.assumptions, '標準の前提は動かない');
  assert.deepEqual(body.actions, fixture.request.actions, '標準の行動は動かない');
  assert.equal(customIsEmpty(f), true);
  assert.equal(customIsEmpty(moved), false);
  assert.deepEqual(built(resetCustom(moved)).body.custom, {assumptions: {}, actions: []});
});

test('行動の候補を「カスタムに入れる」: 標準（カスタムがあればその件数）に足し、取り消すと標準に戻る（標準より下げない）', () => {
  const f = form();
  const added = addToCustom(f, 'consignment', 'meeting', 100);
  assert.equal(added.custom.actions['consignment:meeting'], '5');
  assert.deepEqual(built(added).body.custom.actions, [{source: 'consignment', step: 'meeting', countX100: 500}]);
  const twice = addToCustom(added, 'consignment', 'meeting', 100);
  assert.equal(twice.custom.actions['consignment:meeting'], '6');
  const back = removeFromCustom(twice, 'consignment', 'meeting', 100);
  assert.equal(back.custom.actions['consignment:meeting'], '5');
  const reset = removeFromCustom(back, 'consignment', 'meeting', 100);
  assert.equal(Object.hasOwn(reset.custom.actions, 'consignment:meeting'), false, '標準に戻ったら上書きを外す');
  assert.equal(removeFromCustom(reset, 'consignment', 'meeting', 100).custom.actions['consignment:meeting'], undefined, '標準より下げない');
  // 小数の件数（1.5件）に1件足す
  assert.equal(addToCustom(f, 'acquisition', 'meeting', 100).custom.actions['acquisition:meeting'], '2.5');
  assert.equal(customCountOf(f, f.actions[1]), 150);
  // 標準に無い行動は何もしない
  assert.equal(addToCustom(f, 'committee', 'meeting', 100), f);
});

test('入力の更新は元のオブジェクトを書き換えない（setIn）', () => {
  const f = form();
  const next = setIn(f, ['targets', 'selfYen'], '1');
  assert.equal(f.targets.selfYen, '');
  assert.equal(next.targets.selfYen, '1');
  assert.equal(next.period, f.period, '触らない枝は同じオブジェクトのまま');
  const removed = setIn(next, ['targets', 'selfYen'], undefined);
  assert.equal(Object.hasOwn(removed.targets, 'selfYen'), false);
});
