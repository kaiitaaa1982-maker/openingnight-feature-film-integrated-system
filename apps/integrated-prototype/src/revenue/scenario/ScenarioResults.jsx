// シナリオの比較（段A）の結果の表示: 上部に固定する要約・KPI 4枚・出資の回収・シナリオの横並び（列ごとに同じ4枚）・分布のグラフ・前提の効き・行動の候補・逆算・明細。入力は ScenarioInputs.jsx。
// 応答（POST /api/revenue/scenarios/compare）を scenario-view-model.mjs で表示の形にして描くだけで、金額を計算し直さない。
// 色だけに頼らない（状態は語で添える）。出資の回収で差額が負の行は「回収待ち」と書き、赤にも「未達」にもしない。
import React, {useEffect, useRef} from 'react';
import {Tabs} from '../../ui/Tabs.jsx';
import {SOURCE_LABELS} from './scenario-inputs.mjs';
import {
  NONE, SCENARIO_LABELS, TARGET_LABELS, STAGE_A_ABSENT, yenText, signedYenText, percentText, probabilityText, pointText, monthJa, countText, hoursText, multiplierText,
  scenarioKeys, scenarioKpi, creatorsKpi, deltaFromStandard, recoveryTable, sourceDetailRows, sourceEmptyText, opportunityRows, actionActualRows, tornadoRows,
  candidateRows, reverseCards, distributionChart, noteChips,
} from './scenario-view-model.mjs';
import {customCountOf, decimalX100} from './scenario-form-model.mjs';

// 目標が無いときの案内（目標に依る値は、目標額を送った応答にだけ出る）
const NEEDS_TARGET = '目標額を入れると出ます';
// 需給の曲線の、作品ごとの公開月の出どころ（demand-curve.mjs の releaseSources）
const RELEASE_SOURCE_LABELS = Object.freeze({window: '劇場公開の確定の版', first_sale: '最初の売上月', none: '公開月なし', after_close: '締めた月より後'});

// 値と、その正確な値（検算・読み上げ用）を持つ要素
const Yen = ({value, empty = NONE, signed = false, id, className = ''}) => (
  <span className={`sc-num ${className}`.trim()} data-metric={id} data-yen={value ?? undefined}>{signed ? signedYenText(value, empty) : yenText(value, empty)}</span>
);
const Prob = ({bps, id, empty = NONE}) => <span className="sc-num" data-metric={id} data-bps={bps ?? undefined}>{probabilityText(bps, empty)}</span>;

function Meter({bps, label}) {
  if (bps === null || bps === undefined) return null;
  return <span className="sc-meter" role="img" aria-label={`${label} ${probabilityText(bps)}`}><span style={{width: `${bps / 100}%`}} /></span>;
}

// 10・50・90%点（目標に依らない幅）。3行に分けて出す（長い額が途中で折り返さない）
function Quantiles({quantiles}) {
  return (
    <dl className="sc-quant">
      <div><dt>10%点</dt><dd><Yen value={quantiles.p10Yen} id="p10" /></dd></div>
      <div><dt>50%点</dt><dd><Yen value={quantiles.p50Yen} id="p50" /></dd></div>
      <div><dt>90%点</dt><dd><Yen value={quantiles.p90Yen} id="p90" /></dd></div>
    </dl>
  );
}

// ---------- 注記の帯 ----------

export function NoteBand({response}) {
  const chips = noteChips(response);
  return (
    <section className="sc-notes" aria-label="注記">
      <ul className="sc-chips">
        {chips.map((chip) => <li key={chip.code} className="sc-chip" title={chip.text} data-note={chip.code}>{chip.label}</li>)}
      </ul>
      <details className="sc-notes-more">
        <summary>注記の全文と、段A にないもの</summary>
        <ul>{response.notes.map((note) => <li key={note.code} data-note-text={note.code}>{note.text}</li>)}</ul>
        <p className="sc-hint">段A にないもの（段B で作ります）: {STAGE_A_ABSENT.join('・')}。</p>
      </details>
    </section>
  );
}

// ---------- 上部に固定する要約（カスタム） ----------

// 要約の貼り付く位置＝外枠の上に貼り付く帯（shell の .app-topbar）の高さ。狭い幅では帯が折り返して高くなるので、測って --sc-sticky-top に入れる（要約が帯に隠れない）
function useStickyTop(ref) {
  useEffect(() => {
    const element = ref.current;
    const bar = typeof document === 'undefined' ? null : document.querySelector('.app-topbar');
    if (!element || !bar) return undefined;
    const apply = () => element.style.setProperty('--sc-sticky-top', `${Math.ceil(bar.getBoundingClientRect().height)}px`);
    apply();
    if (typeof ResizeObserver === 'undefined') return undefined;
    const observer = new ResizeObserver(apply);
    observer.observe(bar);
    return () => observer.disconnect();
  }, [ref]);
}

// 前提を動かしているあいだも見えるように画面の上に固定する1行: カスタムの期待値と、目標（本人があれば本人）に届く確率と、それぞれの標準比。
// 値は応答のもの（標準比は応答の値の差。deltaFromStandard）。確率は仮置きの率から出る。使う時間は段A の応答に月ごとの値が無いので段B（#17）
export function SummaryBar({response}) {
  const ref = useRef(null);
  useStickyTop(ref);
  if (!response.scenarios.custom) return null;
  const kpi = scenarioKpi(response, 'custom');
  const delta = deltaFromStandard(response, 'custom');
  const lead = kpi.self ?? kpi.company;
  const reachDelta = lead ? (lead.name === 'self' ? delta.reachSelfBps : delta.reachCompanyBps) : null;
  return (
    <div className="sc-summary" ref={ref} role="group" aria-label="カスタムの要約" data-summary="custom">
      <span>
        <span className="sc-sub">{kpi.label} 期待値</span> <strong><Yen value={kpi.expectedYen} id="summary-expected" /></strong>
        <span className="sc-sub">（標準比 <Yen value={delta.expectedYen} signed id="summary-expected-delta" />）</span>
      </span>
      {lead ? (
        <span>
          <span className="sc-sub">{lead.label}の目標に届く確率</span> <strong><Prob bps={lead.reachBps} id="summary-reach" /></strong>
          <span className="sc-sub">（標準比 <span className="sc-num" data-metric="summary-reach-delta" data-bps={reachDelta ?? undefined}>{pointText(reachDelta)}</span>・仮置きの率から）</span>
        </span>
      ) : <span className="sc-sub">{NEEDS_TARGET}</span>}
    </div>
  );
}

// ---------- KPI 4枚（標準の前提） ----------

function Card({id, title, children, hint}) {
  return (
    <article className="sc-kpi" data-kpi={id}>
      <h3>{title}</h3>
      {children}
      {hint && <p className="sc-hint">{hint}</p>}
    </article>
  );
}

function Line({label, children}) {
  return <div className="sc-line-row"><dt>{label}</dt><dd>{children}</dd></div>;
}

function TargetGap({part}) {
  return (
    <>
      <Line label={`${part.label}の目標との差`}>
        <Yen value={part.gapYen} signed id={`gap-${part.name}`} />
        <span className="sc-sub">（達成率 <span className="sc-num" data-metric={`achievement-${part.name}`} data-bps={part.achievementBps ?? undefined}>{part.achievementBps === null ? '—（期待値が0円以下のため出しません）' : percentText(part.achievementBps)}</span>）</span>
      </Line>
    </>
  );
}

export function KpiCards({response}) {
  const kpi = scenarioKpi(response, 'standard');
  const creators = creatorsKpi(response);
  const targets = [kpi.self, kpi.company].filter(Boolean);
  const lead = kpi.self ?? kpi.company;
  return (
    <section className="sc-section" aria-labelledby="sc-kpi-title">
      <div className="sc-section-head">
        <h2 id="sc-kpi-title">KPI（標準の前提）</h2>
        <p className="sc-hint">基準は計上（税抜）。粗利で測り、会社の売上を並べます。入金と回収額は税込・未確定の参考です。</p>
      </div>
      <div className="sc-kpis">
        <Card id="expected" title="期待値と目標との差" hint="自社出資の粗利だけは、期間内の税込の入金（参考）です。出資額は期間より前に払った扱いで引いていません（出資の回収の表に出します。税抜への換算は U-5 まで未確定）。">
          <p className="sc-big"><Yen value={kpi.expectedYen} id="expected" /></p>
          <dl className="sc-lines">
            <Line label="実績＋確度加重（着地の代わり）"><Yen value={kpi.actualPlusWeightedYen} id="actual-plus-weighted" /></Line>
            <Line label="会社の売上（期待値）"><Yen value={kpi.expectedSalesYen} id="expected-sales" /></Line>
            {targets.map((part) => <TargetGap key={part.name} part={part} />)}
          </dl>
          {!targets.length && <p className="sc-hint">目標額を入れると、差と達成率を出します。</p>}
        </Card>
        <Card id="reach" title="届く確率と幅">
          <p className="sc-big">{lead ? <><Prob bps={lead.reachBps} id={`reach-${lead.name}`} /><span className="sc-sub">（{lead.label}の目標に）</span></> : NONE}</p>
          {lead && <Meter bps={lead.reachBps} label={`${lead.label}の目標に届く確率`} />}
          <dl className="sc-lines">
            {targets.filter((part) => part !== lead).map((part) => <Line key={part.name} label={`${part.label}の目標に届く確率`}><Prob bps={part.reachBps} id={`reach-${part.name}`} /></Line>)}
            {targets.map((part) => <Line key={`wo-${part.name}`} label={`行動を除くと（${part.label}）`}><Prob bps={part.reachWithoutActionsBps} id={`reach-without-actions-${part.name}`} /></Line>)}
          </dl>
          <Quantiles quantiles={kpi.quantiles} />
          {!targets.length && <p className="sc-hint">目標額を入れると確率を出します。10・50・90%点は目標に依りません。</p>}
          <p className="sc-hint">案件どうしは独立、前提は固定、売上の量の振れを含みません。</p>
        </Card>
        <Card id="cash" title="期末2か月の入金予定">
          <p className="sc-big"><Yen value={kpi.cash.lastTwoMonthsYen} id="cash-last-two" /></p>
          <dl className="sc-lines">
            <Line label="1か月遅れると期間の外へ"><Yen value={kpi.cash.slipOutYen} id="cash-slip-out" empty="測れない（入金の遅れが上限）" /></Line>
            <Line label="期間内の入金予定"><Yen value={kpi.cash.periodYen} id="cash-period" /></Line>
            <Line label="期間の外へ入る入金の見込"><Yen value={kpi.cash.nextPeriodYen} id="cash-next-period" /></Line>
            <Line label="来期へ持ち越す粗利の見込"><Yen value={kpi.nextPeriodProfitYen} id="next-period-profit" /></Line>
          </dl>
          {kpi.cash.unscheduledCount > 0 && <p className="sc-hint">入金の月を決められない商談 {kpi.cash.unscheduledCount}件（窓口の支払いの間が無い）は、入金の予定に入れていません。</p>}
        </Card>
        <Card id="creators" title="作り手・権利元へ渡る額">
          <p className="sc-big"><Yen value={creators.totalYen} id="creators-total" empty="未接続" /></p>
          <dl className="sc-lines">
            <Line label="買付の MG（参考）"><Yen value={creators.mgReferenceYen} id="creators-mg" /></Line>
          </dl>
          <p className="sc-hint">販売委託の権利元の取り分の和（期間内の実績）です。ほかの稼ぎ方の分は出していません（0円で埋めません）。作り手の取り分の裏返しなので、シナリオでは動かしません。人件費分と成功報酬は段B です。</p>
        </Card>
      </div>
    </section>
  );
}

// ---------- 出資の回収 ----------

function projectedText(row, key) {
  const value = row.projectedYen[key];
  return value === null ? NONE : signedYenText(value);
}

// visible: 表示するシナリオ（シナリオの横並びの切り替えと同じ）。期末の見込みの差額の列は表示中のシナリオの数だけ出す。渡さなければ全部
export function RecoveryTable({response, visible}) {
  const table = recoveryTable(response);
  const period = response.conditions.period;
  const shownKeys = visible ? table.keys.filter((key) => visible[key]) : table.keys;
  const keys = shownKeys.length ? shownKeys : table.keys;
  const scenarioCount = keys.length;
  const hasRows = table.groups.length > 0;
  return (
    <section className="sc-section" aria-labelledby="sc-recovery-title" data-section="investment-recovery">
      <div className="sc-section-head">
        <h2 id="sc-recovery-title">出資の回収 <span className="sc-tag">税込・参考</span></h2>
        <p className="sc-hint">出資のある案件ごとに1行。出資額と収益は全期間の累計で、期間内（{monthJa(period.from)}〜{monthJa(period.to)}）の分は右の列です。差額＝収益−出資額、回収率＝収益÷出資額、期末の見込みの差額＝実績の差額＋表示中のシナリオの残りの期待値。収益の基準は行ごとの印のとおりで、自社出資は税込の入金、製作委員会は計上（税抜）の取得額です。</p>
      </div>
      {table.unconnected.length > 0 && <p className="sc-note-line" role="status">{table.unconnected.join('・')}は未接続です（0円で埋めていません）。</p>}
      {!hasRows && <p className="sc-empty">出資のある案件がありません。</p>}
      {hasRows && (
        <div className="sc-table-wrap sc-tall" tabIndex={0} role="region" aria-label="出資の回収の表（横と縦にスクロールできます）">
          <table className="sc-table sc-recovery">
            <thead>
              <tr>
                <th scope="col" rowSpan={2} className="sc-sticky">案件</th>
                <th scope="colgroup" colSpan={4}>全期間の累計</th>
                <th scope="colgroup" colSpan={scenarioCount}>期末の見込みの差額（実績の差額＋残りの期待値）</th>
                <th scope="colgroup" colSpan={2}>期間内</th>
              </tr>
              <tr>
                <th scope="col">出資額</th><th scope="col">収益</th><th scope="col">差額</th><th scope="col">回収率</th>
                {keys.map((key) => <th scope="col" key={key}>{SCENARIO_LABELS[key]}</th>)}
                <th scope="col">出資</th><th scope="col">収益</th>
              </tr>
            </thead>
            {table.groups.map((group) => (
              <tbody key={group.kind} data-kind={group.kind}>
                <tr className="sc-group-row"><th scope="rowgroup" colSpan={5 + scenarioCount + 2}>{group.label}<span className="sc-sub">　{group.note}</span></th></tr>
                {group.rows.map((row) => (
                  <tr key={row.key} data-work={row.workId} data-status={row.status}>
                    <th scope="row" className="sc-sticky">
                      <span>{row.title}</span>
                      <span className={`sc-status is-${row.status}`}>{row.statusLabel}</span>
                      <span className="sc-tag" data-basis={row.basis}>収益 {row.basis}</span>
                      {row.note && <span className={`sc-row-note${row.noteIsError ? ' is-error' : ''}`}>{row.note}</span>}
                    </th>
                    <td className="num"><Yen value={row.investmentYen} empty="未確定" /></td>
                    <td className="num"><Yen value={row.revenueYen} empty="未確定" /></td>
                    <td className="num" data-metric="diff" data-yen={row.diffYen ?? undefined}>{signedYenText(row.diffYen, '未確定')}</td>
                    <td className="num" data-metric="rate" data-bps={row.recoveryRateBps ?? undefined}>{percentText(row.recoveryRateBps)}</td>
                    {keys.map((key) => <td className="num" key={key} data-metric={`projected-${key}`} data-yen={row.projectedYen[key] ?? undefined}>{projectedText(row, key)}</td>)}
                    <td className="num"><Yen value={row.periodInvestmentYen} empty="未確定" /></td>
                    <td className="num"><Yen value={row.periodRevenueYen} empty="未確定" /></td>
                  </tr>
                ))}
              </tbody>
            ))}
            <tfoot>
              <tr data-row="total" data-status={table.total.status}>
                <th scope="row" className="sc-sticky"><span>合計（{table.total.rowCount}件）</span><span className={`sc-status is-${table.total.status}`}>{table.total.statusLabel}</span>
                  {table.total.basis && <span className="sc-tag" data-basis={table.total.basis}>収益 {table.total.basis}</span>}</th>
                <td className="num"><Yen value={table.total.investmentYen} id="recovery-total-investment" /></td>
                <td className="num"><Yen value={table.total.revenueYen} id="recovery-total-revenue" /></td>
                <td className="num" data-metric="recovery-total-diff" data-yen={table.total.diffYen ?? undefined}>{signedYenText(table.total.diffYen)}</td>
                <td className="num" data-metric="recovery-total-rate" data-bps={table.total.recoveryRateBps ?? undefined}>{percentText(table.total.recoveryRateBps)}</td>
                {keys.map((key) => <td className="num" key={key} data-metric={`recovery-total-projected-${key}`} data-yen={table.total.projectedYen[key] ?? undefined}>{signedYenText(table.total.projectedYen[key])}</td>)}
                <td className="num"><Yen value={table.total.periodInvestmentYen} /></td>
                <td className="num"><Yen value={table.total.periodRevenueYen} /></td>
              </tr>
            </tfoot>
          </table>
        </div>
      )}
      {hasRows && <p className="sc-hint">表は横に続きます →　差額が負の行は「回収待ち」の語を付けています（出資は出金が先に立つので、未達ではありません）。出資額が無い・0円の行は回収率を出しません。自社出資の出資額は、払込の月を持たないため期間より前に払った扱いで、期間内の出資は0円です。</p>}
      {table.unknown.count > 0 && <p className="sc-note-line" role="status">差額が分からない行 {table.unknown.count}件（出資額か収益が未確定）は合計に入れていません。</p>}
    </section>
  );
}

// ---------- シナリオの横並び ----------

export function ScenarioColumns({response, visible, onToggle}) {
  const keys = scenarioKeys(response);
  const shown = keys.filter((key) => visible[key]);
  const creators = creatorsKpi(response);
  return (
    <section className="sc-section" aria-labelledby="sc-columns-title" data-section="scenario-columns">
      <div className="sc-section-head">
        <h2 id="sc-columns-title">シナリオの横並び</h2>
        <div className="sc-toggles" role="group" aria-label="表示するシナリオ">
          {keys.map((key) => (
            <button key={key} type="button" className="sc-toggle" aria-pressed={Boolean(visible[key])} disabled={visible[key] && shown.length === 1} onClick={() => onToggle(key)}>{SCENARIO_LABELS[key]}</button>
          ))}
        </div>
      </div>
      <p className="sc-hint">楽観・悲観は市場の前提（売上の倍率・回収の量・提案→契約の率・入金の遅れ）だけを決まった幅で動かします。換算率などの交渉の条件は動かしません。確率は全部の案件で数えます。</p>
      <div className="sc-cols" data-cols={shown.length}>
        {shown.map((key) => {
          const kpi = scenarioKpi(response, key);
          const delta = deltaFromStandard(response, key);
          const parts = [kpi.self, kpi.company].filter(Boolean);
          return (
            <article key={key} className="sc-col" data-scenario={key}>
              <header>
                <h3>{kpi.label}</h3>
                <p className="sc-hint">{kpi.moved.length ? kpi.moved.join('・') : key === 'standard' ? '要求の前提のまま' : '標準と同じ'}</p>
              </header>
              <div className="sc-mini" data-kpi="expected">
                <h4>期待値と目標との差</h4>
                <p className="sc-big"><Yen value={kpi.expectedYen} id="expected" /></p>
                {delta && <p className="sc-sub">標準比 <Yen value={delta.expectedYen} signed id="expected-delta" /></p>}
                {parts.map((part) => (
                  <p key={part.name} className="sc-sub">{part.label}の目標との差 <Yen value={part.gapYen} signed id={`gap-${part.name}`} />
                    （達成率 <span className="sc-num" data-metric={`achievement-${part.name}`} data-bps={part.achievementBps ?? undefined}>{percentText(part.achievementBps)}</span>）</p>
                ))}
              </div>
              <div className="sc-mini" data-kpi="reach">
                <h4>届く確率と幅</h4>
                {parts.length ? parts.map((part) => (
                  <p key={part.name} className="sc-sub">{part.label}の目標に届く確率 <Prob bps={part.reachBps} id={`reach-${part.name}`} />
                    {delta && <span className="sc-delta">（標準比 {pointText(part.name === 'self' ? delta.reachSelfBps : delta.reachCompanyBps)}）</span>}</p>
                )) : <p className="sc-hint">{NEEDS_TARGET}</p>}
                <Quantiles quantiles={kpi.quantiles} />
              </div>
              <div className="sc-mini" data-kpi="cash">
                <h4>期末2か月の入金予定</h4>
                <p className="sc-big"><Yen value={kpi.cash.lastTwoMonthsYen} id="cash-last-two" /></p>
                <p className="sc-sub">1か月遅れると期間の外へ <Yen value={kpi.cash.slipOutYen} empty="測れない" id="cash-slip-out" /></p>
                <p className="sc-sub">来期へ持ち越す粗利の見込 <Yen value={kpi.nextPeriodProfitYen} id="next-period-profit" /></p>
              </div>
              <div className="sc-mini" data-kpi="creators">
                <h4>作り手・権利元へ渡る額</h4>
                <p className="sc-big"><Yen value={creators.totalYen} id="creators-total" empty="未接続" /></p>
                <p className="sc-sub">実績の額で、シナリオでは動きません</p>
              </div>
            </article>
          );
        })}
      </div>
    </section>
  );
}

// ---------- 分布のグラフ ----------

export function DistributionChart({response}) {
  const chart = distributionChart(response);
  const keys = scenarioKeys(response);
  const views = ['self', 'company'].filter((name) => response.targetView?.[name]);
  return (
    <section className="sc-section" aria-labelledby="sc-dist-title" data-section="distribution">
      <div className="sc-section-head">
        <h2 id="sc-dist-title">粗利の分布</h2>
        <p className="sc-hint">期間の粗利が、区間（1区間 {yenText(chart.binYen)}）ごとにどの確率で入るか。目標より右の面積が「届く確率」です。</p>
      </div>
      <figure className="sc-chart">
        <div className="sc-chart-scroll" tabIndex={0} role="region" aria-label="粗利の分布のグラフ（横にスクロールできます）">
          <svg viewBox={`0 0 ${chart.width} ${chart.height}`} width={chart.width} height={chart.height} role="img" aria-labelledby="sc-dist-svg-title">
            <title id="sc-dist-svg-title">シナリオごとの期間の粗利の確率分布。値は下の「目標に届く確率」の表にもあります</title>
            {chart.yTicks.map((tick) => (
              <g key={tick.y}><line className="sc-grid" x1={chart.plot.left} x2={chart.plot.right} y1={tick.y} y2={tick.y} /><text className="sc-axis" x={chart.plot.left - 6} y={tick.y} textAnchor="end" dominantBaseline="middle">{tick.label}</text></g>
            ))}
            {chart.xTicks.map((tick) => (
              <g key={tick.yen}><line className="sc-grid is-x" x1={tick.x} x2={tick.x} y1={chart.plot.top} y2={chart.plot.bottom} /><text className="sc-axis" x={tick.x} y={chart.plot.bottom + 16} textAnchor="middle">{tick.label}</text></g>
            ))}
            <text className="sc-axis" x={chart.plot.right} y={chart.height - 4} textAnchor="end">期間の粗利</text>
            {chart.lines.map((line) => <polyline key={line.key} className={`sc-curve is-${line.key}`} points={line.points} fill="none" />)}
            {chart.targets.map((target) => (
              <g key={target.name} className="sc-target"><line x1={target.x} x2={target.x} y1={chart.plot.top - 4} y2={chart.plot.bottom} /><text x={target.labelX} y={target.labelY} textAnchor={target.labelAnchor}>{target.label}</text></g>
            ))}
          </svg>
        </div>
        <ul className="sc-legend" aria-label="凡例">
          {keys.map((key) => (
            <li key={key}><svg width="36" height="10" aria-hidden="true"><line className={`sc-curve is-${key}`} x1="2" x2="34" y1="5" y2="5" /></svg>{SCENARIO_LABELS[key]}</li>
          ))}
          {chart.targets.length > 0 && <li><svg width="36" height="10" aria-hidden="true" className="sc-target"><line x1="18" x2="18" y1="0" y2="10" /></svg>目標</li>}
        </ul>
      </figure>
      <div className="sc-table-wrap">
        <table className="sc-table" aria-label="目標に届く確率">
          <thead><tr><th scope="col">目標に届く確率</th>{keys.map((key) => <th scope="col" key={key}>{SCENARIO_LABELS[key]}</th>)}</tr></thead>
          <tbody>
            {views.map((name) => (
              <tr key={name}>
                <th scope="row">{TARGET_LABELS[name]}（{yenText(response.targetView[name].targetYen)}）</th>
                {keys.map((key) => <td className="num" key={key}><Prob bps={response.targetView[name].scenarios[key].reachBps} id={`reach-${name}-${key}`} /></td>)}
              </tr>
            ))}
            {!views.length && <tr><td colSpan={keys.length + 1} className="sc-empty-cell">{NEEDS_TARGET}</td></tr>}
          </tbody>
        </table>
      </div>
    </section>
  );
}

// ---------- 前提の効き ----------

export function TornadoPanel({response}) {
  const rows = tornadoRows(response);
  return (
    <div className="sc-tornado" data-panel="tornado">
      <p className="sc-hint">市場の前提を1つずつ悲観と楽観へ動かしたときの、期待値の動きです（標準からの差）。基準の線より左が期待値の下がる側、右が上がる側です。交渉の条件と行動は入れていません。</p>
      <ol className="sc-torn">
        {rows.map((row) => (
          <li key={row.key} data-key={row.key}>
            <div className="sc-torn-head"><span className="sc-rank">{row.rank}</span><strong>{row.label}</strong>
              <span className="sc-sub">悲観 {row.pessimistic.text}／標準 {row.standardText}／楽観 {row.optimistic.text}</span></div>
            <div className="sc-torn-bars" aria-hidden="true">
              <span className="sc-axisline" />
              {row.bars.map((bar) => <span key={bar.side} className={`sc-bar is-${bar.direction} is-${bar.side}`} style={{width: `${bar.widthPct}%`}} />)}
            </div>
            <div className="sc-torn-values">
              <span>悲観 <Yen value={row.pessimistic.deltaYen} signed /></span>
              <span>楽観 <Yen value={row.optimistic.deltaYen} signed /></span>
              <span className="sc-sub">幅 <Yen value={row.swingYen} /></span>
            </div>
            {row.check && <p className="sc-check">確かめる: {row.check}</p>}
          </li>
        ))}
      </ol>
    </div>
  );
}

// ---------- 行動の候補 ----------

export function CandidatesPanel({response, form, onAdd, onRemove, onFocusInputs}) {
  const rows = candidateRows(response);
  const standardOf = (row) => {
    const action = form.actions.find((a) => a.source === row.source && a.step === row.step);
    return action ? {action, standard: decimalX100(action.count), custom: customCountOf(form, action)} : null;
  };
  const names = ['self', 'company'].filter((name) => rows.length && rows[0].targets[name]);
  return (
    <div className="sc-cands" data-panel="candidates">
      <p className="sc-hint">いまの行動を1件増やしたときの期待値の増分です。並びは、目標があれば1時間あたりの確率の増分の順、無ければ期待値の増分の順です。段A の候補は「件数を増やす」だけで、時間は行動1件の分（成約後の実行の時間は段B）です。</p>
      <p><button type="button" className="secondary" onClick={onFocusInputs}>カスタムの入力へ</button></p>
      <div className="sc-table-wrap">
        <table className="sc-table">
          <thead>
            <tr>
              <th scope="col">行動</th><th scope="col">1件の時間</th><th scope="col">期待値の増分</th>
              {names.map((name) => <th scope="col" key={name}>{TARGET_LABELS[name]}の目標に届く確率（前→後）</th>)}
              <th scope="col">1時間あたり</th><th scope="col">カスタム</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => {
              const state = standardOf(row);
              const added = state && state.standard !== null && state.custom !== null && state.custom - state.standard >= row.addCountX100;
              const lead = names.length ? row.targets[names[0]] : null;
              return (
                <tr key={row.key} data-candidate={row.key}>
                  <th scope="row">{row.label}<span className="sc-sub">　+{countText(row.addCountX100)}</span></th>
                  <td className="num">{hoursText(row.hoursX100)}</td>
                  <td className="num"><Yen value={row.expectedDeltaYen} signed /></td>
                  {names.map((name) => {
                    const target = row.targets[name];
                    return (
                      <td className="num" key={name}>
                        {target.afterBps === null
                          ? <span className="sc-sub">数えていません（分布が大きすぎる）</span>
                          : <><Prob bps={target.beforeBps} /> → <Prob bps={target.afterBps} id={`candidate-reach-${name}`} /> <span className="sc-delta">（{pointText(target.deltaBps)}）</span></>}
                      </td>
                    );
                  })}
                  <td className="num">
                    {row.perHourYen === null ? NONE : <><Yen value={row.perHourYen} signed />／時間</>}
                    {lead && lead.deltaBps !== null && row.hoursX100 > 0 && <span className="sc-sub"> 確率 {pointText(lead.deltaBps)}／{hoursText(row.hoursX100)}</span>}
                  </td>
                  <td>
                    {added
                      ? <button type="button" className="secondary" aria-label={`${row.label}を増やす（+${countText(row.addCountX100)}）をカスタムから取り消す`} onClick={() => onRemove(row)}>取り消す</button>
                      : <button type="button" aria-label={`${row.label}を+${countText(row.addCountX100)}、カスタムに入れる`} disabled={!state} onClick={() => onAdd(row)}>カスタムに入れる</button>}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ---------- 届くには（逆算） ----------

function Reverse({found, title, tail}) {
  if (!found) return <p className="sc-hint">{title}: 4倍まで増やしても届きません（または数えられる範囲の外です）。</p>;
  return (
    <div className="sc-reverse-found">
      <p><strong>{title}</strong>: <span className="sc-num" data-metric="multiplier" data-x100={found.multiplierX100}>{multiplierText(found.multiplierX100)}</span>（時間 {hoursText(found.hoursX100)}）{tail}</p>
      <ul className="sc-sub-list">{found.actions.map((action) => <li key={action.label}>{action.label} {action.text}</li>)}</ul>
    </div>
  );
}

export function ReversePanel({response}) {
  const cards = reverseCards(response);
  if (!cards.length) return <p className="sc-hint" data-panel="reverse">目標額を入れると、目標に届くまでにいまの行動をそろって増やす倍率（0.05倍刻み・4倍まで）を出します。</p>;
  return (
    <div className="sc-reverse" data-panel="reverse">
      <p className="sc-hint">いまの行動をそろって増やす倍率です。増やしても今期の粗利が増えない行動は固定します。稼ぎ方ごとに届く件数と、規模で届く額は段B で出します。</p>
      {cards.map((card) => (
        <article key={card.name} className="sc-reverse-card" data-target={card.name}>
          <h3>{card.label}の目標（{yenText(card.targetYen)}）</h3>
          <Reverse title="期待値で届く" found={card.expected} tail={card.expected ? <>期待値 <Yen value={card.expected.expectedYen} /></> : null} />
          <Reverse title={`確率${probabilityText(card.goalBps)}に届く`} found={card.probability} tail={card.probability ? <>確率 <Prob bps={card.probability.reachBps} /></> : null} />
          {card.fixed.length > 0 && <p className="sc-sub">固定した行動: {card.fixed.map((row) => `${row.label}（${row.reason}）`).join('・')}</p>}
          {card.stopped && <p className="sc-note-line" role="status">倍率 {multiplierText(card.stopped.multiplierX100)} から先は、分布が大きすぎて確率を数えていません。</p>}
        </article>
      ))}
    </div>
  );
}

// ---------- 明細 ----------

function emptyReason(status) {
  return sourceEmptyText(status);
}

export function DetailPanel({response}) {
  const keys = scenarioKeys(response);
  const sources = sourceDetailRows(response);
  const opps = opportunityRows(response);
  const actual = actionActualRows(response);
  const curve = response.demandCurve;
  const works = response.workSources;
  return (
    <div className="sc-detail" data-panel="detail">
      <section>
        <h3>稼ぎ方別（期間内の粗利）</h3>
        <div className="sc-table-wrap">
          <table className="sc-table sc-sources">
            <thead>
              <tr><th scope="col">稼ぎ方</th><th scope="col">実績</th><th scope="col">確度加重</th><th scope="col">行動から（仮置き）</th>
                {keys.map((key) => <th scope="col" key={key}>期待値（{SCENARIO_LABELS[key]}）</th>)}<th scope="col">会社の売上（標準の期待値）</th></tr>
            </thead>
            <tbody>
              {sources.map((row) => (
                <tr key={row.source} data-source={row.source} data-status={row.status}>
                  <th scope="row">{row.label}{row.awaitingRecovery && <span className="sc-status is-awaiting">回収待ち</span>}
                    {row.status !== 'connected' && <span className="sc-status is-unknown">{emptyReason(row.status)}</span>}</th>
                  <td className="num"><Yen value={row.actualYen} empty={emptyReason(row.status)} /></td>
                  <td className="num"><Yen value={row.weightedYen} /></td>
                  <td className="num"><Yen value={row.actionYen} /></td>
                  {keys.map((key) => <td className="num" key={key}><Yen value={row.expectedYen[key]} empty={emptyReason(row.status)} id={`source-${row.source}-${key}`} /></td>)}
                  <td className="num"><Yen value={row.expectedSalesYen} empty={emptyReason(row.status)} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="sc-hint">期待値＝実績＋確度加重＋行動からの見込（内訳をそれぞれ整数にした和。配りません）。回収待ちの出資は負の内訳をそのまま足します。</p>
      </section>

      <section>
        <h3>商談ごと（標準）</h3>
        <div className="sc-table-wrap">
          <table className="sc-table">
            <thead><tr><th scope="col">商談</th><th scope="col">稼ぎ方</th><th scope="col">段階</th><th scope="col">確度</th><th scope="col">残りの額</th><th scope="col">期間内の粗利</th><th scope="col">確度加重</th><th scope="col">売上の月</th><th scope="col">入金の月</th></tr></thead>
            <tbody>
              {opps.included.map((row) => (
                <tr key={row.id} data-opportunity={row.id} data-placement={row.placement}>
                  <th scope="row">{row.name}{row.workTitle && <span className="sc-sub">　{row.workTitle}</span>}</th>
                  <td>{row.sourceLabel}</td><td>{row.stageLabel}</td>
                  <td className="num">{probabilityText(row.probabilityBps)}</td>
                  <td className="num"><Yen value={row.remainingYen} /></td><td className="num"><Yen value={row.valueYen} /></td><td className="num"><Yen value={row.weightedYen} /></td>
                  <td>{monthJa(row.revenueMonth)}{row.overdue && <span className="sc-status is-unknown">期限切れ（次の月に立つとみなす）</span>}<span className="sc-sub">　{row.placementLabel}</span></td>
                  <td>{monthJa(row.paymentMonth, '決められない')}</td>
                </tr>
              ))}
              {!opps.included.length && <tr><td colSpan={9} className="sc-empty-cell">期待値に入れた商談はありません。</td></tr>}
            </tbody>
          </table>
        </div>
        {opps.excluded.length > 0 && (
          <>
            <h4>期待値に入れていない商談（件数と額を横に出します）</h4>
            <ul className="sc-sub-list" data-list="excluded">
              {opps.excluded.map((row) => <li key={row.id}>{row.name}: {row.reasonLabel}（見込額 <Yen value={row.expectedYen} empty="未定" />）</li>)}
            </ul>
          </>
        )}
      </section>

      <section>
        <h3>行動の実績（期間内。作品のある営業の行動だけ）</h3>
        <div className="sc-table-wrap">
          <table className="sc-table">
            <thead><tr><th scope="col">稼ぎ方</th><th scope="col">面談</th><th scope="col">提案</th><th scope="col">契約（受注で成約日が期間内）</th></tr></thead>
            <tbody>
              {actual.map((row) => <tr key={row.source} data-source={row.source}><th scope="row">{row.label}</th><td className="num">{row.meeting}件</td><td className="num">{row.proposal}件</td><td className="num" data-metric={`contracts-${row.source}`}>{row.contract}件</td></tr>)}
              <tr data-row="total"><th scope="row">合計</th><td className="num">{response.actionActuals.total.meeting}件</td><td className="num">{response.actionActuals.total.proposal}件</td><td className="num" data-metric="contracts-total">{response.actionActuals.total.contract}件</td></tr>
            </tbody>
          </table>
        </div>
      </section>

      <section>
        <h3>作品ごとの稼ぎ方と参考の額</h3>
        <div className="sc-table-wrap sc-tall">
          <table className="sc-table">
            <thead><tr><th scope="col">作品</th><th scope="col">稼ぎ方</th><th scope="col">買付額（参考）</th><th scope="col">MG（参考）</th><th scope="col">MG 残（参考・未控除）</th><th scope="col">入金の累計（税込・未確定）</th><th scope="col">期間内の入金（税込・未確定）</th></tr></thead>
            <tbody>
              {works.map((row) => (
                <tr key={row.workId} data-work={row.workId}>
                  <th scope="row">{row.title}{row.overlap && <span className="sc-status is-unknown">重なり</span>}</th>
                  <td>{row.sources.map((source) => SOURCE_LABELS[source]).join('・')}</td>
                  <td className="num"><Yen value={row.purchaseYen} /></td><td className="num"><Yen value={row.mgContractYen} /></td><td className="num"><Yen value={row.mgBalanceYen} /></td>
                  <td className="num"><Yen value={row.receiptsTotalYen} /></td><td className="num"><Yen value={row.receiptsPeriodYen} /></td>
                </tr>
              ))}
              {!works.length && <tr><td colSpan={7} className="sc-empty-cell">稼ぎ方に当てはまる作品がありません。</td></tr>}
            </tbody>
          </table>
        </div>
        <p className="sc-hint">出資と契約が重なる作品 {response.overlapCount}件は、契約のある稼ぎ方を先にしています。参考の額は期待値に使いません。</p>
      </section>

      <section>
        <h3>需給の曲線の元</h3>
        <p className="sc-sub" data-metric="curve-source">起点 {curve.origin === 'release_month' ? '公開月' : curve.origin}・作品 {curve.workCount}本・売上 {curve.lineCount}行（{monthJa(curve.throughMonth)}まで）。公開月の出どころ: {Object.entries(curve.releaseSources).map(([key, count]) => `${RELEASE_SOURCE_LABELS[key] ?? key} ${count}本`).join('・')}</p>
        <div className="sc-table-wrap">
          <table className="sc-table">
            <thead><tr><th scope="col">窓口</th><th scope="col">状態</th><th scope="col">元の作品</th><th scope="col">元の行</th></tr></thead>
            <tbody>
              {curve.channels.map((row) => (
                <tr key={row.channel ?? row.key ?? row.label} data-channel={row.channel ?? row.key ?? undefined}>
                  <th scope="row">{row.label ?? row.channel ?? row.key}</th>
                  <td>{row.status === 'no_curve' ? '曲線なし（均等に配る）' : '曲線あり'}</td>
                  <td className="num">{row.workCount ?? NONE}</td><td className="num">{row.lineCount ?? NONE}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}

// ---------- 詳細のタブ ----------

export function DetailTabs({response, form, onAdd, onRemove, onFocusInputs}) {
  const tabs = [{id: 'tornado', label: '前提の効き'}, {id: 'candidates', label: '行動の候補'}, {id: 'reverse', label: '届くには'}, {id: 'detail', label: '明細'}];
  return (
    <section className="sc-section" aria-labelledby="sc-tabs-title" data-section="tabs">
      <h2 id="sc-tabs-title" className="sc-visually-hidden">効き・候補・逆算・明細</h2>
      <Tabs tabs={tabs} urlKey="sctab" label="効き・候補・逆算・明細">
        {(active) => (
          active === 'tornado' ? <TornadoPanel response={response} />
            : active === 'candidates' ? <CandidatesPanel response={response} form={form} onAdd={onAdd} onRemove={onRemove} onFocusInputs={onFocusInputs} />
              : active === 'reverse' ? <ReversePanel response={response} />
                : <DetailPanel response={response} />
        )}
      </Tabs>
    </section>
  );
}
