// シナリオの比較（段A）。標準・楽観・悲観とカスタムを、同じ実績で横に並べ、期待値・目標に届く確率・出資の回収・作り手と権利元へ渡る額を見る。
// 計画: 会社ルートの plans/2026-10-09-sales-producer-kpi.md の A-3（M-2 A: 列＝シナリオ・右に前提パネル・効き/候補/明細はタブ・注記は上の帯。M-1 A: KPI を上）。
// - 値は保存しない。入力（form）から毎回、要求の本文を作って POST /api/revenue/scenarios/compare に送り、応答を描く（状態は use-scenario-compare.mjs）
// - 目標額・差・達成率は、この画面の状態と送った要求の応答にだけ置く。URL（shell/url-state.mjs）・localStorage・フォームの自動入力には載せない
// - data-ready: 画面が読んだ応答の sourceHash と一致したときだけ付ける印（値は sourceHash）。送信中・誤り・入力が変わったあとは付けない
// - 閲覧用のプレビュー（記録した応答だけで動く静的な版）は POST を通さないので、この画面は計算できない旨を出す（scripts/build-preview.mjs はこの画面を巡回しない）
// - モック（M-2 A）にあって段A に置かないもの: 「CSV に書き出す」は段B（#17 の書き出し・#20 の比較の文書データと出口）、「使う時間」のパネルは段B（#17。段A の応答に月ごとの時間が無い）
import React, {useCallback} from 'react';
import {useShell} from '../../shell/context.mjs';
import {Notice} from '../../ui/Notice.jsx';
import {isPreviewRefusal, monthJa} from './scenario-view-model.mjs';
import {NoteBand, SummaryBar, KpiCards, RecoveryTable, ScenarioColumns, DistributionChart, DetailTabs} from './ScenarioResults.jsx';
import {ConditionsForm, CustomPanel, StandardPanel, OpportunityPanel, CUSTOM_FIRST_INPUT_ID} from './ScenarioInputs.jsx';
import {useScenarioCompare} from './use-scenario-compare.mjs';
import './scenario-compare.css';

function Meta({response}) {
  const {conditions} = response;
  return (
    <p className="sc-meta" data-meta="conditions">
      <span className="sc-chip">基準 計上（税抜）固定</span>
      <span className="sc-chip">期間 {monthJa(conditions.period.from)}〜{monthJa(conditions.period.to)}</span>
      <span className="sc-chip">締めた月 {monthJa(conditions.closedMonth)}</span>
      <span className="sc-chip">実績 {monthJa(conditions.actualWindow.from)}〜{monthJa(conditions.actualWindow.to)}</span>
      <span className="sc-chip">対象 {conditions.scope.projectCount}案件・{conditions.scope.workCount}作品</span>
    </p>
  );
}

// 読み込み・計算の失敗の表示。閲覧用のプレビューが POST を断ったとき（403・preview: read-only）は、保存の失敗ではないので別の文にし、再試行は添えない
export function CompareFailure({error, onRetry, retryLabel}) {
  if (isPreviewRefusal(error)) {
    return (
      <Notice tone="info" title="閲覧用のプレビューでは、この画面は計算できません"
        message="入力の値から毎回計算する画面です（何も保存しません）。プレビューは記録した応答だけで動くため、計算の要求を通せません。実際の画面で開いてください。" />
    );
  }
  return <Notice error={error} onRetry={onRetry} retryLabel={retryLabel} />;
}

// 画面の組み立て（状態を持たない）。試験は、応答と入力を渡してこれを描く
export function ScenarioCompareView({
  form, response, errors = [], loading = false, error = null, hash = null, visible, onToggle = () => {}, onForm = () => {},
  onAdd = () => {}, onRemove = () => {}, onRetry = () => {}, onFocusInputs = () => {},
}) {
  const visibleScenarios = visible ?? {standard: true, optimistic: true, pessimistic: true, custom: true};
  return (
    <section className="sc" aria-label="シナリオの比較" aria-busy={loading || undefined} data-source-hash={response?.sourceHash} data-ready={hash ?? undefined}>
      {error && <CompareFailure error={error} onRetry={onRetry} retryLabel="もう一度計算する" />}
      <ConditionsForm form={form} onForm={onForm} loading={loading} ready={Boolean(hash)} errors={errors} />
      {!response && !error && <p className="sc-loading" role="status">読み込んでいます…</p>}
      {response && (
        <div className={`sc-layout${loading ? ' is-stale' : ''}`}>
          <div className="sc-main">
            <SummaryBar response={response} />
            <Meta response={response} />
            <NoteBand response={response} />
            <KpiCards response={response} />
            <RecoveryTable response={response} visible={visibleScenarios} />
            <ScenarioColumns response={response} visible={visibleScenarios} onToggle={onToggle} />
            <DistributionChart response={response} />
            <DetailTabs response={response} form={form} onAdd={onAdd} onRemove={onRemove} onFocusInputs={onFocusInputs} />
            <OpportunityPanel form={form} response={response} onForm={onForm} />
          </div>
          <section className="sc-aside" aria-label="前提と行動">
            <CustomPanel form={form} onForm={onForm} />
            <StandardPanel form={form} onForm={onForm} />
          </section>
        </div>
      )}
    </section>
  );
}

export default function ScenarioCompare({request: requestProp}) {
  const shell = useShell();
  const request = requestProp || shell.request;
  const state = useScenarioCompare({request});
  const focusInputs = useCallback(() => {
    if (typeof document !== 'undefined') document.getElementById(CUSTOM_FIRST_INPUT_ID)?.focus();
  }, []);

  if (state.bootError) {
    return <section className="sc" aria-label="シナリオの比較"><CompareFailure error={state.bootError} onRetry={state.retryBoot} retryLabel="読み直す" /></section>;
  }
  if (!state.form) return <section className="sc" aria-label="シナリオの比較" aria-busy="true"><p className="sc-loading" role="status">読み込んでいます…</p></section>;

  return (
    <ScenarioCompareView form={state.form} response={state.shown?.response ?? null} errors={state.errors} loading={state.loading} error={state.error} hash={state.hash}
      visible={state.visible} onToggle={state.toggle} onForm={state.update} onAdd={state.add} onRemove={state.remove} onRetry={state.retryCompare} onFocusInputs={focusInputs} />
  );
}
