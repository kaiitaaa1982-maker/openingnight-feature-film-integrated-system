// シナリオの比較の画面（ScenarioCompare.jsx）が使う、応答（POST /api/revenue/scenarios/compare の本文）から表示の形への変換と書式。純関数。
// 計画: 会社ルートの plans/2026-10-09-sales-producer-kpi.md の A-3。応答の金額は整数円・率は bp。金額は応答の値をそのまま出す。
// 画面で新しく作る金額は次の3つだけで、どれも整数どうしの差か切り捨ての整数除算（小数・Math.round は使わない。money-rules）:
//   標準比（deltaFromStandard の期待値の差）、前提の効きの悲観・楽観の期待値−標準（tornadoRows）、行動の候補の1時間あたり（candidateRows の perHourYen＝期待値の増分×100÷時間 の切り捨て）。
//   scenario-view-model.test.mjs が応答の値から独立に照合する。ほかの金額の丸めは書式の桁区切りだけ。
// 書式は 値が無いときに 0 で埋めない（null は「—」か、理由の語（未接続・未確定・回収待ち））。グラフの座標などの表示の計算もここで行う。
import {SOURCES, SOURCE_LABELS} from './scenario-inputs.mjs';
import {SCENARIO_KEYS, SCENARIO_RANGES, ASSUMPTION_LABELS} from './scenario-model.mjs';
import {int} from '../../ui/format.mjs';
import {labelOf} from '../../ui/labels.mjs';
import {bpsToPercent} from '../../royalty/royalty-model.mjs';

export const NONE = '—';
export const SCENARIO_LABELS = Object.freeze({standard: '標準', optimistic: '楽観', pessimistic: '悲観', custom: 'カスタム'});
export const STEP_LABELS = Object.freeze({meeting: '面談', proposal: '提案'});
export const TARGET_LABELS = Object.freeze({self: '本人', company: '会社'});
export const RECOVERY_STATUS_LABELS = Object.freeze({awaiting: '回収待ち', recovered: '回収済み', unknown: '未確定', unconnected: '未接続'});
export const PLACEMENT_LABELS = Object.freeze({in_period: '期間内', before_period: '期間の前', after_period: '期間の後'});
export const EXCLUDED_LABELS = Object.freeze({lost: '失注', no_source: '源泉の指定なし', no_amount: '見込額なし', no_month: '売上の月なし'});
// 出資の回収の表で行をまとめる稼ぎ方（出資額と収益の取り方を見出しに書く）
export const RECOVERY_GROUPS = Object.freeze([
  {kind: 'own_investment', label: '自社出資', note: '出資額＝作品マスタの最新の版の出資額、収益＝作品単位の入金（税込・参考）'},
  {kind: 'committee', label: '製作委員会', note: '出資額＝自社の払込の累計、収益＝自社の取得額（分配）の累計（計上・税抜）'},
]);
// 出資の回収の収益の基準（行ごとの印）。自社出資は作品の入金（税込）、製作委員会は自社の取得額（計上・税抜）。合計は両方の行を足す
export const RECOVERY_BASIS_LABELS = Object.freeze({own_investment: '税込', committee: '計上'});
export const RECOVERY_MIXED_BASIS = '税込と計上の混在';

export const actionLabel = (source, step) => `${SOURCE_LABELS[source] ?? source}の${STEP_LABELS[step] ?? step}`;
export const scenarioKeys = (response) => SCENARIO_KEYS.filter((key) => response.scenarios[key]);

// ---------- 書式 ----------

export function yenText(value, empty = NONE) {
  return value === null || value === undefined ? empty : `${int(value)}円`;
}

export function signedYenText(value, empty = NONE) {
  if (value === null || value === undefined) return empty;
  if (value === 0) return '±0円';
  return `${value > 0 ? '+' : ''}${int(value)}円`;
}

// 率（bp → 12.5%）。2桁までの小数
export function percentText(bps, empty = NONE) {
  return bps === null || bps === undefined ? empty : `${bpsToPercent(bps)}%`;
}

// 確率（bp）。1%未満は「<1%」、99%超は「>99%」。ちょうど0と100は「0%」「100%」。正確な値は data-bps に持つ
export function probabilityText(bps, empty = NONE) {
  if (bps === null || bps === undefined) return empty;
  if (bps === 0) return '0%';
  if (bps < 100) return '<1%';
  if (bps > 9900 && bps < 10000) return '>99%';
  const half = bps + 50;
  return `${(half - (half % 100)) / 100}%`;
}

// 確率の差（bp の差 → +20pt）
export function pointText(deltaBps, empty = NONE) {
  if (deltaBps === null || deltaBps === undefined) return empty;
  if (deltaBps === 0) return '±0pt';
  return `${deltaBps > 0 ? '+' : '-'}${bpsToPercent(Math.abs(deltaBps))}pt`;
}

export function monthJa(month, empty = NONE) {
  const match = /^(\d{4})-(\d{2})/.exec(month ?? '');
  return match ? `${match[1]}年${Number(match[2])}月` : empty;
}

export const monthsText = (n) => `${n}か月`;
export const countText = (countX100) => {
  const whole = (countX100 - (countX100 % 100)) / 100;
  const rest = countX100 % 100;
  return rest ? `${whole}.${String(rest).padStart(2, '0').replace(/0$/, '')}件` : `${whole}件`;
};
export const hoursText = (hoursX100) => `${countText(hoursX100).slice(0, -1)}時間`;
export const multiplierText = (multiplierX100) => `${countText(multiplierX100).slice(0, -1)}倍`;

// 市場の前提の値の書式（率は %、入金の遅れは月）
export function assumptionValueText(key, value) {
  return key === 'paymentDelayMonths' ? monthsText(value) : percentText(value);
}

const divTrunc = (a, b) => (a - (a % b)) / b;

// ---------- 注記の帯（上） ----------

// 応答の注記（notes）のうち、帯に短く出すもの。コード → 短い語。全文は応答の notes をそのまま「注記の全文」に出す
const NOTE_CHIPS = Object.freeze({
  provisional: '確度と率は仮置き',
  basis: '入金は税込・未確定（参考）',
  mg_balance: 'MG 残は未控除',
  acquisition_meetings: '買付候補の面談は数えていない',
});

export function noteChips(response) {
  const chips = [];
  const seen = new Set();
  const add = (code, label, text) => {
    if (seen.has(code)) return;
    seen.add(code);
    chips.push({code, label, text});
  };
  for (const note of response.notes) {
    if (NOTE_CHIPS[note.code]) add(note.code, NOTE_CHIPS[note.code], note.text);
    else if (note.code.endsWith('_unconnected')) add(note.code, `${SOURCE_LABELS[note.code.replace('_unconnected', '')] ?? '源泉'}は未接続（0円で埋めない）`, note.text);
    else if (note.code.endsWith('_unknown')) add(note.code, `${SOURCE_LABELS[note.code.replace('_unknown', '')] ?? '源泉'}は未確定`, note.text);
    else if (note.code === 'unlinked') add(note.code, `未紐付けの報告 ${response.unlinkedReports.count}件`, note.text);
  }
  add('no_save', '保存・採用なし（要求の本文で計算）', '段A は値を保存しません。送った要求の本文だけで計算し、画面は目標額を URL・ブラウザの保存・入力欄の自動補完に残しません');
  return chips;
}

// 段A に無いもの（計画の「段A」の節）。画面に注記として出す
export const STAGE_A_ABSENT = Object.freeze([
  '保存と採用', '通過率', '稟議', '受託（未接続）', '目標の表', '指標マスタ', '見直しの提案', 'PL への接続', '入金の税抜換算', '支払いの節目',
  '段階の履歴', '前の予測との差', '交渉の候補', '作品の無いステップ（買付候補の面談・受託・稟議・組成）', '自社出資の成功報酬',
]);

// ---------- KPI ----------

// 前提のうち標準から動かした値（楽観・悲観・カスタムの見出しの下に出す）
export function movedAssumptions(response, key) {
  const base = response.scenarios.standard.assumptions;
  const scenario = response.scenarios[key].assumptions;
  return Object.keys(ASSUMPTION_LABELS).filter((name) => scenario[name] !== base[name])
    .map((name) => ({key: name, label: ASSUMPTION_LABELS[name], text: assumptionValueText(name, scenario[name])}));
}

// 行動の件数のうち標準から動かしたもの
export function movedActions(response, key) {
  const base = new Map(response.scenarios.standard.actions.map((row) => [`${row.source}:${row.step}`, row.countX100]));
  return response.scenarios[key].actions.filter((row) => base.get(`${row.source}:${row.step}`) !== row.countX100)
    .map((row) => ({source: row.source, step: row.step, label: actionLabel(row.source, row.step), text: countText(row.countX100)}));
}

// 目標に依る値（差・達成率・届く確率）。目標額を送っていなければ null
function targetPart(response, key, name) {
  const view = response.targetView?.[name];
  if (!view) return null;
  const row = view.scenarios[key];
  return {name, label: TARGET_LABELS[name], targetYen: view.targetYen, gapYen: row.gapYen, achievementBps: row.achievementBps,
    reachBps: row.reachBps, reachWithoutActionsBps: row.reachWithoutActionsBps};
}

// 1つのシナリオの KPI 4枚の元（期待値と目標との差・届く確率と幅・期末2か月の入金予定・作り手と権利元へ渡る額）
export function scenarioKpi(response, key) {
  const s = response.scenarios[key];
  return {
    key, label: SCENARIO_LABELS[key],
    expectedYen: s.expectedYen, actualYen: s.actualYen, weightedYen: s.weightedYen, actionYen: s.actionYen,
    actualPlusWeightedYen: s.actualPlusWeightedYen, expectedSalesYen: s.expectedSalesYen, actualPlusWeightedSalesYen: s.actualPlusWeightedSalesYen,
    self: targetPart(response, key, 'self'), company: targetPart(response, key, 'company'),
    quantiles: s.quantiles, quantilesWithoutActions: s.quantilesWithoutActions,
    cash: s.cash, nextPeriodProfitYen: s.nextPeriodProfitYen,
    moved: [...movedAssumptions(response, key).map((row) => `${row.label} ${row.text}`), ...movedActions(response, key).map((row) => `${row.label} ${row.text}`)],
  };
}

// 作り手・権利元へ渡る額（実績の値。シナリオでは動かさない）。販売委託が未接続なら null
export function creatorsKpi(response) {
  return {totalYen: response.creators.totalYen, mgReferenceYen: response.creators.mgReferenceYen, unconnected: response.creators.totalYen === null};
}

// 標準との差（シナリオ比較の列に添える）。標準の列は null
export function deltaFromStandard(response, key) {
  if (key === 'standard') return null;
  const standard = scenarioKpi(response, 'standard');
  const kpi = scenarioKpi(response, key);
  const reachDelta = (name) => (standard[name] && kpi[name] ? kpi[name].reachBps - standard[name].reachBps : null);
  return {expectedYen: kpi.expectedYen - standard.expectedYen, reachSelfBps: reachDelta('self'), reachCompanyBps: reachDelta('company')};
}

// ---------- 出資の回収 ----------

// 出資案件ごとの行と合計。列: 出資額・収益・差額・回収率（全期間の累計）、期間内の出資・収益、期末の見込みの差額（シナリオごと）。
// 差額が負の行は「回収待ち」の語で示し、赤にも「未達」にもしない
export function recoveryTable(response) {
  const keys = scenarioKeys(response);
  const standard = response.scenarios.standard.investmentRecovery;
  const projectedBy = Object.fromEntries(keys.map((key) => [key, new Map(response.scenarios[key].investmentRecovery.rows.map((row) => [`${row.kind}:${row.workId}`, row.projectedDiffYen]))]));
  const rowOf = (row) => ({
    key: `${row.kind}:${row.workId}`, kind: row.kind, workId: row.workId, title: row.title,
    investmentYen: row.investmentYen, revenueYen: row.revenueYen, diffYen: row.diffYen, recoveryRateBps: row.recoveryRateBps,
    periodInvestmentYen: row.periodInvestmentYen, periodRevenueYen: row.periodRevenueYen, remainingExpectedYen: row.remainingExpectedYen,
    status: row.status, statusLabel: RECOVERY_STATUS_LABELS[row.status], basis: RECOVERY_BASIS_LABELS[row.kind], note: row.error ?? row.holdNote ?? null, noteIsError: Boolean(row.error),
    projectedYen: Object.fromEntries(keys.map((key) => [key, projectedBy[key].get(`${row.kind}:${row.workId}`) ?? null])),
  });
  const groups = RECOVERY_GROUPS.map((group) => ({...group, rows: standard.rows.filter((row) => row.kind === group.kind).map(rowOf)})).filter((group) => group.rows.length > 0);
  const total = standard.total;
  // 合計に入る行（差額が分かる行）の収益の基準。両方あれば混在と書く
  const totalBases = [...new Set(standard.rows.filter((row) => row.diffYen !== null).map((row) => RECOVERY_BASIS_LABELS[row.kind]))];
  return {
    keys, groups,
    total: {
      basis: totalBases.length > 1 ? RECOVERY_MIXED_BASIS : totalBases[0] ?? null,
      rowCount: total.rowCount, investmentYen: total.investmentYen, revenueYen: total.revenueYen, diffYen: total.diffYen, recoveryRateBps: total.recoveryRateBps,
      periodInvestmentYen: total.periodInvestmentYen, periodRevenueYen: total.periodRevenueYen, status: total.status, statusLabel: RECOVERY_STATUS_LABELS[total.status],
      projectedYen: Object.fromEntries(keys.map((key) => [key, response.scenarios[key].investmentRecovery.total.projectedDiffYen])),
    },
    unknown: standard.unknown,
    unconnected: standard.unconnected.map((kind) => SOURCE_LABELS[kind]),
  };
}

// ---------- 稼ぎ方別の明細 ----------

export function sourceDetailRows(response) {
  const keys = scenarioKeys(response);
  const sourceStatus = new Map(response.sources.map((row) => [row.source, row]));
  return SOURCES.map((source) => {
    const standard = response.scenarios.standard.bySource.find((row) => row.source === source);
    return {
      source, label: SOURCE_LABELS[source], status: sourceStatus.get(source).status, unknownCount: sourceStatus.get(source).unknownCount, awaitingRecovery: standard.awaitingRecovery,
      actualYen: standard.actualYen, weightedYen: standard.weightedYen, actionYen: standard.actionYen,
      expectedYen: Object.fromEntries(keys.map((key) => [key, response.scenarios[key].bySource.find((row) => row.source === source).expectedYen])),
      expectedSalesYen: standard.expectedSalesYen,
    };
  });
}

// 源泉が null の理由の語
export function sourceEmptyText(status) {
  return status === 'unconnected' ? '未接続' : status === 'unknown' ? '未確定' : NONE;
}

// ---------- 商談の明細 ----------

export function opportunityRows(response) {
  const list = new Map(response.opportunityList.map((row) => [row.id, row]));
  const included = response.scenarios.standard.opportunities.map((row) => ({
    id: row.opportunityId, name: row.name, workTitle: list.get(row.opportunityId)?.workTitle ?? null, sourceLabel: SOURCE_LABELS[row.source],
    stageLabel: labelOf('opportunityStage', row.stage), probabilityBps: row.probabilityBps, remainingYen: row.remainingYen, valueYen: row.valueYen, weightedYen: row.weightedYen,
    revenueMonth: row.revenueMonth, overdue: row.overdue, paymentMonth: row.paymentMonth, placementLabel: PLACEMENT_LABELS[row.placement], placement: row.placement,
  }));
  const excluded = response.scenarios.standard.excluded.map((row) => ({
    id: row.opportunityId, name: list.get(row.opportunityId)?.name ?? `商談 ${row.opportunityId}`, workTitle: list.get(row.opportunityId)?.workTitle ?? null,
    reasonLabel: EXCLUDED_LABELS[row.reason], expectedYen: row.expectedYen,
  }));
  return {included, excluded};
}

// 行動の実績（稼ぎ方×段。契約は受注で close_date が期間内の件数）
export function actionActualRows(response) {
  return response.actionActuals.bySource.map((row) => ({
    source: row.source, label: SOURCE_LABELS[row.source] ?? '稼ぎ方の指定なし', meeting: row.meeting, proposal: row.proposal, contract: row.contract,
  }));
}

// ---------- 前提の効き ----------

const bpsOrMonths = (key, value) => assumptionValueText(key, value);

export function tornadoRows(response) {
  const standardYen = response.scenarios.standard.expectedYen;
  const standardAssumptions = response.scenarios.standard.assumptions;
  const rows = response.tornado.map((row, index) => {
    const lowYen = row.pessimistic.expectedYen - standardYen;
    const highYen = row.optimistic.expectedYen - standardYen;
    return {
      rank: index + 1, key: row.key, label: row.label, swingYen: row.swingYen, check: row.check,
      pessimistic: {text: bpsOrMonths(row.key, row.pessimistic.value), deltaYen: lowYen},
      standardText: bpsOrMonths(row.key, standardAssumptions[row.key]),
      optimistic: {text: bpsOrMonths(row.key, row.optimistic.value), deltaYen: highYen},
    };
  });
  const widest = rows.reduce((n, row) => Math.max(n, Math.abs(row.pessimistic.deltaYen), Math.abs(row.optimistic.deltaYen)), 0);
  const width = (deltaYen) => (widest === 0 ? 0 : (Math.abs(deltaYen) / widest) * 50);
  // 低い側（期待値が下がる）は左、高い側は右。どちらの側の棒かは語（悲観・楽観）で添える
  return rows.map((row) => ({
    ...row,
    bars: [
      {side: 'pessimistic', label: '悲観', deltaYen: row.pessimistic.deltaYen, direction: row.pessimistic.deltaYen < 0 ? 'left' : 'right', widthPct: width(row.pessimistic.deltaYen)},
      {side: 'optimistic', label: '楽観', deltaYen: row.optimistic.deltaYen, direction: row.optimistic.deltaYen < 0 ? 'left' : 'right', widthPct: width(row.optimistic.deltaYen)},
    ],
  }));
}

// ---------- 行動の候補と逆算 ----------

// 行動の候補（件数を増やす）。目標額があれば目標に届く確率の前後を添え、並びは目標（本人があれば本人）の1時間あたりの確率の増分の順。
// 目標額が無ければ期待値の増分の順（応答の candidates の順）
export function candidateRows(response) {
  const names = ['self', 'company'].filter((name) => response.targetView?.[name]);
  const key = (row) => `${row.source}:${row.step}`;
  const reachOf = (name) => new Map(response.targetView[name].candidates.map((row) => [key(row), row]));
  const reach = Object.fromEntries(names.map((name) => [name, reachOf(name)]));
  const order = names.length ? response.targetView[names[0]].candidates.map(key) : response.candidates.map(key);
  const base = new Map(response.candidates.map((row) => [key(row), row]));
  return order.map((id) => {
    const row = base.get(id);
    // 目標の側に同じ候補が無い（形が違う）ときは確率を出さない（0 で埋めない）
    const perTarget = Object.fromEntries(names.map((name) => {
      const target = reach[name].get(id);
      return [name, target ? {label: TARGET_LABELS[name], beforeBps: target.reachBeforeBps, afterBps: target.reachAfterBps, deltaBps: target.reachDeltaBps, stopped: target.stopped}
        : {label: TARGET_LABELS[name], beforeBps: null, afterBps: null, deltaBps: null, stopped: null}];
    }));
    return {
      key: id, source: row.source, step: row.step, label: actionLabel(row.source, row.step), addCountX100: row.addCountX100, hoursX100: row.hoursX100,
      expectedDeltaYen: row.expectedDeltaYen,
      perHourYen: row.hoursX100 === 0 ? null : divTrunc(row.expectedDeltaYen * 100, row.hoursX100),
      targets: perTarget,
    };
  });
}

// 逆算（そろって増やす倍率）。目標ごとに、期待値で届く倍率と確率70%に届く倍率。固定した行動に理由を添える
const FIXED_REASONS = Object.freeze({down: '増やすと今期は下がる', flat: '増やしても今期は変わらない'});

export function reverseCards(response) {
  return ['self', 'company'].filter((name) => response.targetView?.[name]).map((name) => {
    const view = response.targetView[name];
    const reverse = view.reverse;
    const found = (row, extra) => (row ? {multiplierX100: row.multiplierX100, hoursX100: row.hoursX100, actions: row.actions.map((action) => ({label: actionLabel(action.source, action.step), text: countText(action.countX100)})), ...extra(row)} : null);
    return {
      name, label: TARGET_LABELS[name], targetYen: view.targetYen, goalBps: reverse.goalBps,
      expected: found(reverse.expected, (row) => ({expectedYen: row.expectedYen})),
      probability: found(reverse.probability, (row) => ({reachBps: row.reachBps})),
      fixed: reverse.fixed.map((row) => ({label: actionLabel(row.source, row.step), reason: FIXED_REASONS[row.reason]})),
      stopped: reverse.stopped ? {multiplierX100: reverse.stopped.multiplierX100, reason: reverse.stopped.reason} : null,
    };
  });
}

// ---------- 分布のグラフ ----------

const BIN_LADDER = Object.freeze([10000, 20000, 50000, 100000, 200000, 500000, 1000000, 2000000, 5000000, 10000000, 20000000, 50000000, 100000000, 200000000, 500000000, 1000000000, 2000000000, 5000000000, 10000000000]);
const TARGET_BINS = 36;
const floorTo = (value, step) => value - ((value % step) + step) % step;
const ceilTo = (value, step) => floorTo(value + step - 1, step);
const niceAtLeast = (value) => BIN_LADDER.find((step) => step >= value) ?? BIN_LADDER.at(-1);

// 4つのシナリオの分布（1万円の格子）を、グラフの区間にまとめて折れ線の座標にする。x は円、y は確率。
// 区間の幅は 全体の幅 ÷ 36 以上のきりのよい額。目標の縦線は応答の目標額の位置（目標が範囲の外なら範囲を広げる）
export function distributionChart(response, {width = 720, height = 280, left = 52, right = 16, top = 22, bottom = 40} = {}) {
  const keys = scenarioKeys(response);
  const targets = ['self', 'company'].filter((name) => response.targetView?.[name]).map((name) => ({name, label: `目標（${TARGET_LABELS[name]}）`, yen: response.targetView[name].targetYen}));
  const gridYen = response.gridYen;
  // 点の数は格子の数まで増えうるので、Math.min(...配列) のように引数に展開しない
  let low = Infinity;
  let high = -Infinity;
  for (const key of keys) {
    for (const [yen] of response.scenarios[key].distribution.points) {
      if (yen < low) low = yen;
      if (yen > high) high = yen;
    }
  }
  for (const target of targets) {
    low = Math.min(low, target.yen);
    high = Math.max(high, target.yen);
  }
  const binYen = niceAtLeast(divCeil(Math.max(high - low, gridYen), TARGET_BINS));
  const start = floorTo(low, binYen);
  const count = divTrunc(ceilTo(high + 1, binYen) - start, binYen);
  const plotWidth = width - left - right;
  const plotHeight = height - top - bottom;
  const xOf = (yen) => left + ((yen - start) / (count * binYen)) * plotWidth;
  const series = keys.map((key) => {
    const bins = new Array(count).fill(0);
    for (const [yen, probability] of response.scenarios[key].distribution.points) bins[divTrunc(yen - start, binYen)] += probability;
    return {key, label: SCENARIO_LABELS[key], bins};
  });
  const peak = Math.max(...series.flatMap((row) => row.bins), 1 / 1000);
  const yOf = (probability) => top + plotHeight - (probability / peak) * plotHeight;
  const fixed = (n) => n.toFixed(1);
  const lines = series.map((row) => ({
    key: row.key, label: row.label, bins: row.bins,
    points: row.bins.map((probability, index) => `${fixed(left + ((2 * index + 1) / (2 * count)) * plotWidth)},${fixed(yOf(probability))}`).join(' '),
  }));
  // x の目盛り: 範囲を4つほどに区切るきりのよい額（万円）
  const tickStep = niceAtLeast(divCeil(Math.max(high - low, gridYen), 4));
  const xTicks = [];
  for (let yen = ceilTo(low, tickStep); yen <= high; yen += tickStep) xTicks.push({yen, x: Number(fixed(xOf(yen))), label: `${int(divTrunc(yen, 10000))}万円`});
  const peakPercent = peak * 100;
  const yTicks = [0, 1 / 2, 1].map((fraction) => ({y: Number(fixed(yOf(peak * fraction))), label: `${(peakPercent * fraction).toFixed(peakPercent < 10 ? 1 : 0)}%`}));
  return {
    width, height, plot: {left, right: width - right, top, bottom: height - bottom}, binYen, binStartYen: start, lines, xTicks, yTicks,
    targets: placeTargetLabels(targets.map((target) => ({...target, x: Number(fixed(xOf(target.yen)))})), top),
  };
}

// 目標の線の見出しの置き場。線どうしが近い（90px 未満）ときは、後の見出しを図の中の1段下に左寄せで置き、重ならないようにする
const LABEL_GAP = 90;
function placeTargetLabels(targets, top) {
  const order = [...targets].sort((a, b) => a.x - b.x);
  const below = new Set();
  for (let i = 1; i < order.length; i += 1) {
    if (order[i].x - order[i - 1].x < LABEL_GAP && !below.has(order[i - 1].name)) below.add(order[i].name);
  }
  return targets.map((target) => (below.has(target.name)
    ? {...target, labelX: target.x + 4, labelY: top + 12, labelAnchor: 'start'}
    : {...target, labelX: target.x, labelY: top - 8, labelAnchor: 'middle'}));
}

const divCeil = (a, b) => divTrunc(a + b - 1, b);

// ---------- 前提の入力欄の範囲（カスタムのスライダー） ----------

// 前提の効き（トルネード図）と同じ幅の目盛り（悲観・標準・楽観。モデルの下限・上限に収める）
export function assumptionTicks(key, standardValue) {
  const range = SCENARIO_RANGES[key];
  const within = (value) => Math.min(range.max, Math.max(range.min, value));
  return {pessimistic: within(standardValue + range.pessimistic), standard: standardValue, optimistic: within(standardValue + range.optimistic)};
}

// 市場の前提のスライダーの範囲。標準を中心に、楽観・悲観の幅の3倍までを上限と下限にする（モデルの下限・上限に収める）
export function assumptionBounds(key, standardValue) {
  const range = SCENARIO_RANGES[key];
  const span = Math.max(Math.abs(range.pessimistic), Math.abs(range.optimistic)) * 3;
  if (key === 'paymentDelayMonths') return {min: range.min, max: range.max, step: 1};
  return {min: Math.max(range.min, standardValue - span), max: Math.min(range.max, standardValue + span), step: 100};
}

// ---------- 画面の「読み終わった」印（data-ready） ----------

// 画面が読んだ応答の sourceHash と一致したときだけ、その hash を返す（それ以外は null）。
// shown: 表示中の応答と、それを作った本文の鍵。renderedHash: その応答を描き終えたあとに画面が覚えた hash。signature: いまの入力から作った本文の鍵。
// 送信中・誤り・入力が変わったあと（表示中の応答が今の入力のものでない）は、描き終えていても null
export function readyHash({shown, renderedHash, loading = false, error = null, signature = null}) {
  if (!shown || loading || error) return null;
  if (shown.signature !== signature) return null;
  const hash = shown.response?.sourceHash;
  return typeof hash === 'string' && hash !== '' && renderedHash === hash ? hash : null;
}

// 閲覧用のプレビュー（記録した応答だけで動く静的な版）は GET 以外を通さず、403 と body.preview: 'read-only' を返す。
// この画面は保存しない POST で計算するので、プレビューでは計算できない。保存の失敗ではないので、画面は別の文で知らせる
export const isPreviewRefusal = (error) => error?.status === 403 && error?.body?.preview === 'read-only';
