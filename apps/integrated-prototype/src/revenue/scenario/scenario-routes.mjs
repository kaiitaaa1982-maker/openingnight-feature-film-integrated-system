// シナリオの比較（段A）の API。計画: 会社ルートの plans/2026-10-09-sales-producer-kpi.md の A-2。Worker でも動くよう node:* を import しない。
//   POST /api/revenue/scenarios/compare   要求の本文（scenario-inputs.mjs の形）で、標準・楽観・悲観（とカスタム）を同じ実績で並べ、
//                                         前提の効き・行動の候補・出資の回収・作り手と権利元へ渡る額・需給の曲線と、
//                                         作品ごとの稼ぎ方と参考の列（買付額・MG・MG 残・作品単位の入金〈税込・未確定〉）を返す
// - 本文を保存しない（読むだけ。監査の記録も書かない）。目標額と、それに依る差・達成率・届く確率は、送った要求の応答にだけ入れる
// - 権限: 制作担当は403。財務の権限がある案件（permittedProjects(…, true)）の作品だけを読む。見えない商談を本文で指したら400
// - 基準は計上で固定（basis は受けない）。応答の形はフェーズ1の K-5（title・conditions・dataAsOf・definitionVersion・basis・tables・notes・checks・sourceHash）に
//   計算の結果を並べる。sourceHash は 要求の本文（目標額を含む）・定義の版・読んだ行から作った実績（facts）・曲線・作品ごとの参考の列の hash で、同じ入力で同じ値
import {normalizeCompareRequest, normalizeScenarioFacts, ScenarioInputError, SOURCE_LABELS} from './scenario-inputs.mjs';
import {compareScenarios, DEFINITION_VERSION} from './scenario-model.mjs';
import {buildScenarioFacts, FACTS_VERSION} from './scenario-facts-model.mjs';
import {demandCurve} from './demand-curve.mjs';
import {readScenarioSources} from './scenario-store.mjs';

export const SCENARIO_COMPARE_TITLE = 'シナリオの比較';
const STATUS_LABELS = Object.freeze({awaiting: '回収待ち', recovered: '回収済み', unknown: '未確定', unconnected: '未接続'});

const yen = (key, label) => ({key, label, type: 'yen'});
const INVESTMENT_COLUMNS = Object.freeze([
  {key: 'title', label: '作品', type: 'text'}, {key: 'kindLabel', label: '稼ぎ方', type: 'text'},
  yen('investmentYen', '出資額（累計）'), yen('revenueYen', '収益（累計）'), yen('diffYen', '差額（収益−出資額）'),
  {key: 'recoveryRateBps', label: '回収率', type: 'bps'}, yen('periodInvestmentYen', '期間内の出資額（自社出資は期間より前に払った扱いで0円）'), yen('periodRevenueYen', '期間内の収益'),
  yen('remainingExpectedYen', '残りの期待値'), yen('projectedDiffYen', '期末の見込みの差額'), {key: 'statusLabel', label: '状態', type: 'text'},
]);
// 作品ごとの稼ぎ方と参考の列（計画の段A の表。買付額・MG・MG 残は源泉4の参考、入金は税込・未確定で作品単位）。期待値には使わない
const WORK_COLUMNS = Object.freeze([
  {key: 'title', label: '作品', type: 'text'}, {key: 'sourceLabels', label: '稼ぎ方', type: 'text'},
  yen('purchaseYen', '買付額（参考）'), yen('mgContractYen', 'MG（参考）'), yen('mgBalanceYen', 'MG 残（参考・未控除）'),
  yen('receiptsTotalYen', '入金の累計（税込・未確定）'), yen('receiptsPeriodYen', '期間内の入金（税込・未確定）'),
]);
const SOURCE_COLUMNS = Object.freeze([
  {key: 'label', label: '稼ぎ方', type: 'text'}, yen('actualYen', '実績（期間内の粗利）'), yen('weightedYen', '確度加重'), yen('actionYen', '行動から（仮置き）'),
  yen('expectedYen', '期待値'), yen('actualSalesYen', '実績（会社の売上）'), yen('expectedSalesYen', '期待値（会社の売上）'),
]);

// 出資の回収の表（標準のシナリオ。差額が負の行は「回収待ち」で、未達と書かない）
function investmentTable(recovery) {
  const label = (row) => ({...row, kindLabel: SOURCE_LABELS[row.kind], statusLabel: STATUS_LABELS[row.status]});
  return {
    name: 'investmentRecovery', title: '出資の回収', columns: INVESTMENT_COLUMNS,
    rows: recovery.rows.map(label),
    total: {...recovery.total, title: '合計', kindLabel: null, statusLabel: STATUS_LABELS[recovery.total.status]},
  };
}

function checksOf(result, facts) {
  const scenarios = Object.values(result.scenarios);
  const recovery = result.scenarios.standard.investmentRecovery;
  const holder = facts.consignment === null ? null : facts.consignment.reduce((n, row) => n + row.holderAmountPeriodYen, 0);
  const diffOk = (row) => row.diffYen === null || row.diffYen === row.revenueYen - row.investmentYen;
  return [
    {code: 'expected_is_sum', label: '期待値は稼ぎ方別の内訳の和', ok: scenarios.every((s) => s.expectedYen === s.bySource.reduce((n, row) => n + (row.expectedYen ?? 0), 0))},
    {code: 'investment_diff', label: '出資の回収の差額は収益−出資額', ok: recovery.rows.every(diffOk) && diffOk(recovery.total)},
    {code: 'creators_consignment', label: '作り手・権利元へ渡る額は販売委託の権利元の取り分の和', ok: result.creators.totalYen === holder},
  ];
}

export function registerScenarioRoutes(app, ctx) {
  const {db, bad, body, permittedProjects, sha256, canonical} = ctx;

  app.post('/api/revenue/scenarios/compare', async (c) => {
    const i = c.get('identity');
    if (!i || i.role === 'production') return bad(c, 'シナリオの比較は財務の画面です（制作担当は見られません）', 403);
    let input, request;
    try {
      input = await body(c);
    } catch (error) {
      return bad(c, error.message, 400, undefined, error);
    }
    try {
      request = normalizeCompareRequest(input);
    } catch (error) {
      if (error instanceof ScenarioInputError) return bad(c, `要求の本文を確かめてください（${error.message}）`, 400, {field: error.field});
      throw error;
    }
    const projectIds = (await permittedProjects(db, i, true)).map((row) => row.id);
    const raw = projectIds.length ? await readScenarioSources(db, i, ctx, {projectIds, period: request.period, closedMonth: request.closedMonth}) : null;
    if (!raw) return bad(c, '財務の権限がある作品がありません', 403);

    // 本文が指す商談は、財務の権限で見える商談だけ（無い商談と見えない商談を区別しない）
    const visible = new Set(raw.opportunities.map((row) => row.id));
    const hidden = request.opportunities.filter((row) => !visible.has(row.id)).map((row) => row.id);
    if (hidden.length) return bad(c, `見えない商談を指しています（商談 ${hidden.join('・')}）。財務の権限がある案件の商談だけを指定してください`, 400, {field: 'opportunities'});

    let built, facts, result;
    try {
      built = buildScenarioFacts(raw, request);
      facts = normalizeScenarioFacts(built.facts);
      result = compareScenarios(request, facts);
    } catch (error) {
      if (!(error instanceof ScenarioInputError)) throw error;
      // facts の形の誤りは記録の側の問題、それ以外（分布が大きすぎるなど）は本文の側の問題
      if (error.field.startsWith('facts')) return bad(c, `記録を読めません（${error.message}）。管理者に記録の確認を頼んでください`, 409, {field: error.field});
      return bad(c, `要求の本文を確かめてください（${error.message}）`, 400, {field: error.field});
    }
    const curve = demandCurve({works: raw.works, saleLines: raw.saleLines, throughMonth: request.closedMonth});
    const titleOf = new Map(raw.works.map((work) => [work.id, work.title]));
    const workSources = built.sourceOfWork.filter((row) => row.sources.length).map((row) => ({...row, title: titleOf.get(row.workId)}));
    // 参考の列（作品単位の入金など）は facts に入らないので、作品→源泉の対応の行も hash に入れる
    const sourceHash = await sha256(canonical({definitionVersion: DEFINITION_VERSION, factsVersion: FACTS_VERSION, curveVersion: curve.definitionVersion, request, facts, curve, workSources}));

    const notes = [...result.notes];
    if (built.outrightOverlapWorkIds.length) {
      notes.push({code: 'overlap_outright', text: `買い切りの買付にも入る自社出資の作品 ${built.outrightOverlapWorkIds.length}件は、売上をすべて買付に数え、自社出資の回収には入金を当てていません（出資の回収の収益は0円）`});
    }
    notes.push({code: 'investment_recovery', text: '出資の回収の収益は、自社出資は作品の入金（税込・参考）、委員会は自社の取得額の累計です。差額が負の行は回収待ちで、未達ではありません'});
    if (curve.channels.every((row) => row.status === 'no_curve')) notes.push({code: 'no_curve', text: '需給の曲線の元になる売上明細がありません（曲線なし。配るときは均等に配ります）'});

    const standard = result.scenarios.standard;
    return c.json({
      ok: true,
      title: SCENARIO_COMPARE_TITLE,
      conditions: {period: request.period, closedMonth: request.closedMonth, actualWindow: {from: built.window.from, to: built.window.to},
        basis: result.basis, scope: {projectCount: projectIds.length, workCount: raw.works.length}},
      dataAsOf: {closedMonth: request.closedMonth, generatedAt: new Date().toISOString()},
      ...result,
      factsVersion: FACTS_VERSION,
      notes,
      workSources,
      opportunityList: raw.opportunities.map((row) => ({...row, workTitle: titleOf.get(row.workId)})),
      demandCurve: curve,
      tables: [
        {name: 'bySource', title: '稼ぎ方別（標準）', columns: SOURCE_COLUMNS, rows: standard.bySource},
        investmentTable(standard.investmentRecovery),
        {name: 'workSources', title: '作品ごとの稼ぎ方と参考の額', columns: WORK_COLUMNS,
          rows: workSources.map((row) => ({...row, sourceLabels: row.sources.map((source) => SOURCE_LABELS[source]).join('・')}))},
      ],
      checks: checksOf(result, facts),
      sourceHash,
    });
  });
}
