// 年間推移ダッシュボード。売上（計上月・販売月）・請求・入金を同じ月の列で並べ、月末の未請求残・未入金残と前年比を出す。
// グラフの軸（どの数字を棒にするか）は URL の dash に残る。金額は税込（請求・入金と比べるため）。
import React, {useEffect, useMemo, useState} from 'react';
import {useShell} from '../shell/context.mjs';
import {useConditions, ConditionBar} from '../ui/ConditionBar.jsx';
import {describeConditions, monthText} from '../ui/condition-model.mjs';
import {DataGrid} from '../ui/DataGrid.jsx';
import {ReportOutputBar} from '../ui/ReportOutputBar.jsx';
import {Notice} from '../ui/Notice.jsx';
import {gridSheetSpec} from '../ui/grid-model.mjs';
import {yen, rate, dateTimeJst} from '../ui/format.mjs';
import {dashboardSummary} from './annual-dashboard-model.mjs';
import './reports.css';

const CONDITIONS = ['fiscalYear', 'period'];
const SERIES = [
  {value: 'salesAccounting', label: '売上（計上月）'},
  {value: 'salesSales', label: '売上（販売月）'},
  {value: 'billed', label: '請求'},
  {value: 'received', label: '入金'},
];
const COLUMNS = [
  {key: 'month', label: '月', type: 'month', sticky: true},
  {key: 'salesAccounting', label: '売上（計上月）', type: 'yen', total: 'sum'},
  {key: 'salesSales', label: '売上（販売月）', type: 'yen', total: 'sum'},
  {key: 'billed', label: '請求', type: 'yen', total: 'sum'},
  {key: 'received', label: '入金', type: 'yen', total: 'sum'},
  {key: 'unbilled', label: '月末の未請求残', type: 'yen', total: 'not-summable'},
  {key: 'unpaid', label: '月末の未入金残', type: 'yen', total: 'not-summable'},
];
const shortMonth = (ym) => `${Number(ym.slice(5, 7))}月`;

function SeriesChart({months, values, label}) {
  const max = Math.max(1, ...values.map((v) => Math.abs(v)));
  const w = 720, h = 170, pad = 28, bw = (w - pad * 2) / Math.max(1, months.length);
  const base = h - 22;
  const y = (v) => base - (Math.max(0, v) / max) * (h - 44);
  const total = values.reduce((a, b) => a + b, 0);
  return (
    <figure className="rp-chart">
      <svg viewBox={`0 0 ${w} ${h}`} role="img" aria-label={`${label}の月別の棒グラフ。期間計 ${yen(total)}`}>
        {values.map((v, i) => (
          <g key={months[i]}>
            <rect x={pad + bw * i + 4} y={y(v)} width={Math.max(1, bw - 8)} height={Math.max(0, base - y(v))} className="rp-bar">
              <title>{`${monthText(months[i])}: ${yen(v)}`}</title>
            </rect>
            <text x={pad + bw * i + bw / 2} y={h - 6} textAnchor="middle" className="rp-axis">{shortMonth(months[i])}</text>
          </g>
        ))}
      </svg>
      <figcaption><span className="rp-key rp-key-bar" /> {label}（期間計 {yen(total)}。負の月は取消を差し戻した月で、棒は0で止めています）</figcaption>
    </figure>
  );
}

export function AnnualDashboard({fiscal, onNavigate}) {
  const shell = useShell();
  const navigate = onNavigate || shell.navigate;
  const values = useConditions(CONDITIONS, {fiscalStartMonth: fiscal?.fiscalStartMonth});
  const dash = SERIES.some((s) => s.value === shell.getParam('dash', '')) ? shell.getParam('dash', '') : 'salesAccounting';
  const [state, setState] = useState({});
  const query = useMemo(() => (values.from && values.to ? new URLSearchParams({from: values.from, to: values.to}).toString() : ''), [values.from, values.to]);

  useEffect(() => {
    if (!query || !values.valid) { setState({}); return undefined; }
    let live = true;
    setState((previous) => ({...previous, loading: true, error: null}));
    shell.request(`/reports/annual-dashboard?${query}`).then((body) => live && setState({body})).catch((error) => live && setState({error}));
    return () => { live = false; };
  }, [query, values.valid, shell]);

  const body = state.body;
  const k = body?.kpis;
  const title = '年間推移ダッシュボード（売上・請求・入金）';
  const seriesLabel = SERIES.find((s) => s.value === dash)?.label;

  function sheets() {
    const conditions = [...describeConditions(values, CONDITIONS), ['金額', '税込']];
    const dataAsOf = body.dataAsOf?.latestImportAt;
    return [
      gridSheetSpec({columns: COLUMNS, rows: body.rows, exportSpec: {name: '月別', title, period: values.periodLabel, conditions, dataAsOf,
        notes: [body.basis, '月末の未請求残・未入金残はその月末時点の残高で、足し上げられません。']}}),
      {name: '要約', title: `${title} 要約`, conditions, dataAsOf, columns: [{key: 'k', label: '項目', type: 'text'}, {key: 'v', label: '値', type: 'text'}], freezeCols: 1, rows: [
        {k: '売上（計上月）', v: yen(k.sales)}, {k: '請求', v: yen(k.billed)}, {k: '入金', v: yen(k.received)},
        {k: '期末の未請求残', v: yen(k.unbilledAtEnd)}, {k: '期末の未入金残', v: yen(k.unpaidAtEnd)},
        {k: '前年同期の売上（計上月）', v: k.previousSales ? yen(k.previousSales) : '前年の売上なし'}, {k: '前年比', v: k.yoy ? rate(k.yoy) : '—'},
        {k: '範囲と数え方', v: body.basis},
      ]},
    ];
  }

  return (
    <section className="card rp-report" aria-label={title}>
      <header className="rp-head">
        <div>
          <h2>{title}</h2>
          <p className="rp-muted">同じ期間の売上・請求・入金を月ごとに並べ、請求漏れと入金待ちを月末の残高で確かめます。金額は税込です。</p>
        </div>
        {body && <ReportOutputBar sheets={sheets} name="年間推移ダッシュボード" period={values.from && values.to ? `${values.from}〜${values.to}` : ''} title={title} subtitle={values.periodLabel} />}
      </header>
      <ConditionBar conditions={CONDITIONS} values={values} fiscalConfirmed={fiscal?.confirmed} />
      {state.error && <Notice error={state.error} />}
      {state.loading && !body && <p className="rp-muted" aria-busy="true">集計中…</p>}
      {body && (
        <>
          <p className="rp-muted" aria-live="polite">{dashboardSummary(body, yen)}</p>
          <div className="rp-tiles">
            <div><span>売上（計上月）</span><strong>{yen(k.sales)}</strong></div>
            <div><span>請求</span><strong>{yen(k.billed)}</strong></div>
            <div><span>入金</span><strong>{yen(k.received)}</strong></div>
            <div className={k.unbilledAtEnd > 0 ? 'is-warn' : undefined}><span>期末の未請求残</span><strong>{yen(k.unbilledAtEnd)}</strong></div>
            <div className={k.unpaidAtEnd > 0 ? 'is-warn' : undefined}><span>期末の未入金残</span><strong>{yen(k.unpaidAtEnd)}</strong></div>
            <div><span>前年比（売上）</span><strong>{k.yoy ? rate(k.yoy) : '—'}</strong><small>{k.previousSales ? `前年同期 ${yen(k.previousSales)}` : '前年の売上なし'}</small></div>
          </div>
          {body.attention.map((item) => (
            <Notice key={item.key} tone="warn" message={item.message}
              actions={item.key === 'unbilled'
                ? <button type="button" className="secondary" onClick={() => navigate('売上', {billing: 'unbilled'})}>未請求の売上明細を見る</button>
                : <button type="button" className="secondary" onClick={() => navigate('帳票センター', {report: 'receivables'})}>売掛金の一覧を見る</button>} />
          ))}
          <div className="on-field">
            <span className="on-field-label">グラフにする数字</span>
            <div className="on-segmented" role="group" aria-label="グラフにする数字">
              {SERIES.map((option) => (
                <button key={option.value} type="button" aria-pressed={option.value === dash} onClick={() => shell.setParam('dash', option.value === 'salesAccounting' ? null : option.value)}>{option.label}</button>
              ))}
            </div>
          </div>
          <SeriesChart months={body.months} values={body.values[dash]} label={seriesLabel} />
          <DataGrid columns={COLUMNS} rows={body.rows} rowKey="month" persistKey="annual-dashboard" showTotals totalLabel="期間計" emptyText="この期間の数字はありません" />
          <p className="rp-muted">{body.basis} 月末の未請求残・未入金残はその月末時点の残高のため、合計欄は「合計不可」です。未請求残には、請求書を出さない取引（取引先が支払明細を出す形など）の売上も含まれます。</p>
          <p className="rp-muted">データ時点: 最終取込 {body.dataAsOf.latestImportAt ? dateTimeJst(body.dataAsOf.latestImportAt) : 'なし'}（JST）</p>
        </>
      )}
    </section>
  );
}

export default AnnualDashboard;
