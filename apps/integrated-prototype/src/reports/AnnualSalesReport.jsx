// 年間売上（月別推移）。条件は URL に保存し、表は12か月＋四半期・上下期・年度計・構成比・前年計・前年比。
// 月のセルを押すと、その行の直下にその月の元明細が開く。Excel は「集計」「元明細」「照合」「条件」の4シート。
import React, {useEffect, useMemo, useState} from 'react';
import {useShell} from '../shell/context.mjs';
import {useConditions, ConditionBar} from '../ui/ConditionBar.jsx';
import {conditionsToQuery, describeConditions, AXIS_OPTIONS, monthText} from '../ui/condition-model.mjs';
import {DataGrid} from '../ui/DataGrid.jsx';
import {ReportOutputBar} from '../ui/ReportOutputBar.jsx';
import {Notice} from '../ui/Notice.jsx';
import {gridSheetSpec} from '../ui/grid-model.mjs';
import {yen, int, rate, dateTimeJst} from '../ui/format.mjs';
import './reports.css';

const ANNUAL_AXES = [...AXIS_OPTIONS, {value: 'deal', label: '取引区分別'}];
const CONDITIONS = ['fiscalYear', 'period', 'basis', 'tax', 'axis', 'work', 'partner', 'distribution'];
const shortMonth = (ym) => `${Number(ym.slice(5, 7))}月`;

function MonthChart({months, values, cumulative, future}) {
  const max = Math.max(1, ...values.map((v) => Math.abs(v)));
  const maxCum = Math.max(1, ...cumulative.map((v) => Math.abs(v)));
  const w = 720, h = 170, pad = 28, bw = (w - pad * 2) / months.length;
  const y = (v) => h - 22 - (Math.max(0, v) / max) * (h - 44);
  const cy = (v) => h - 22 - (Math.max(0, v) / maxCum) * (h - 44);
  const line = cumulative.map((v, i) => `${pad + bw * i + bw / 2},${cy(v)}`).join(' ');
  return (
    <figure className="rp-chart">
      <svg viewBox={`0 0 ${w} ${h}`} role="img" aria-label={`月別売上の棒グラフと累計の線。年度計 ${yen(cumulative.at(-1) || 0)}`}>
        {values.map((v, i) => (
          <g key={months[i]}>
            <rect x={pad + bw * i + 4} y={y(v)} width={bw - 8} height={Math.max(0, h - 22 - y(v))} className={future[i] ? 'rp-bar is-future' : 'rp-bar'}>
              <title>{`${monthText(months[i])}: ${yen(v)}`}</title>
            </rect>
            <text x={pad + bw * i + bw / 2} y={h - 6} textAnchor="middle" className="rp-axis">{shortMonth(months[i])}</text>
          </g>
        ))}
        <polyline points={line} className="rp-cum" />
      </svg>
      <figcaption><span className="rp-key rp-key-bar" /> 月別 <span className="rp-key rp-key-line" /> 累計（右端 {yen(cumulative.at(-1) || 0)}）</figcaption>
    </figure>
  );
}

// 帳票の行・月から、売上明細の画面の条件（URL）を作る
function salesListParams(row, axis, query, month) {
  const source = new URLSearchParams(query);
  const params = {};
  if (month) { params.period = 'custom'; params.from = month; params.to = month; } else {
    params.period = 'custom'; params.from = source.get('from'); params.to = source.get('to');
  }
  const keys = row.keys || [];
  if (axis === 'work') params.workId = keys[0];
  else if (axis === 'partner' || axis === 'partner-distribution') params.partnerId = keys[0];
  else if (axis === 'distribution') params.distribution = keys[0];
  else if (axis === 'product') params.productId = String(keys[0]);
  else if (axis === 'deal') params.deal = keys[0];
  if (axis === 'partner-distribution') params.distribution = keys[1];
  if (source.get('workId')) params.workId = source.get('workId');
  if (source.get('partnerId')) params.partnerId = source.get('partnerId');
  return params;
}

function DrillRows({row, month, query, request, onNavigate, onClearMonth, axis}) {
  const [state, setState] = useState({loading: true});
  useEffect(() => {
    let live = true;
    const params = new URLSearchParams(query);
    params.set('key', row.key);
    if (month) params.set('month', month);
    params.set('limit', '50');
    setState({loading: true});
    request(`/reports/annual-sales/lines?${params}`).then((body) => live && setState({body})).catch((error) => live && setState({error}));
    return () => { live = false; };
  }, [row.key, month, query, request]);
  if (state.loading) return <p className="rp-muted">元明細を読み込み中…</p>;
  if (state.error) return <Notice error={state.error} />;
  const {body} = state;
  const columns = [
    {key: 'accounting_month', label: '計上月', type: 'month'},
    {key: 'sales_month', label: '販売月', type: 'text', value: (r) => `${monthText(r.sales_month)}${r.sales_month_estimated ? '（推定）' : ''}`},
    {key: 'partner_name', label: '取引先', type: 'text'},
    {key: 'work_title', label: '作品', type: 'text'},
    {key: 'product_name', label: '商品', type: 'text', value: (r) => (r.product_id ? `${r.product_sku}｜${r.product_name}` : '商品未登録')},
    {key: 'distribution_label', label: '流通', type: 'text'},
    {key: 'description', label: '内容', type: 'text', wrap: true},
    {key: 'quantity', label: '数量', type: 'int', total: 'sum'},
    {key: 'amount', label: '金額（配賦後）', type: 'yen', total: 'sum'},
    {key: 'report_key', label: '報告', type: 'code'},
    {key: 'source_row', label: '原本行', type: 'int', total: 'none'},
  ];
  return (
    <div className="rp-drill">
      <p className="rp-drill-head">
        <strong>{row.label}</strong>{month ? `・${monthText(month)}` : '・期間全体'}の元明細 {body.count}件（合計 {yen(body.total)}）
        {body.count > body.rows.length && `。先頭${body.rows.length}件を表示`}
        {month && onClearMonth && <button type="button" className="text" onClick={onClearMonth}>期間全体の明細を見る</button>}
      </p>
      <DataGrid columns={columns} rows={body.rows} rowKey={(r) => `${r.id}:${r.work_id}`} maxHeight="320px" emptyText="この条件の明細はありません" />
      {onNavigate && <button type="button" className="secondary" onClick={() => onNavigate('売上', salesListParams(row, axis, query, month))}>売上明細の画面で全{body.count}件を見る</button>}
    </div>
  );
}

export function AnnualSalesReport({data, fiscal, defaultAxis = 'total', title = '年間売上（月別推移）', onNavigate}) {
  const shell = useShell();
  const request = shell.request;
  const values = useConditions(CONDITIONS, {fiscalStartMonth: fiscal?.fiscalStartMonth, defaults: {axis: defaultAxis}, axisOptions: ANNUAL_AXES});
  const query = useMemo(() => conditionsToQuery(values, CONDITIONS), [values]);
  const [state, setState] = useState({loading: true});
  const [drill, setDrill] = useState({});
  const [expandRequest, setExpandRequest] = useState(null);
  const [allLines, setAllLines] = useState(null);

  useEffect(() => {
    if (!values.valid) return undefined;
    let live = true;
    setState((previous) => ({...previous, loading: true, error: null}));
    setAllLines(null);
    request(`/reports/annual-sales?${query}`).then((body) => live && setState({body})).catch((error) => live && setState({error}));
    const params = new URLSearchParams(query);
    params.set('limit', '2000');
    request(`/reports/annual-sales/lines?${params}`).then((body) => live && setAllLines(body)).catch(() => live && setAllLines(null));
    return () => { live = false; };
  }, [query, values.valid, request]);

  const body = state.body;
  const works = data?.works || [];
  const partners = data?.partners || [];
  const distributionOptions = useMemo(() => (data?.distributionTypes || []).map((t) => ({value: t.code, label: t.label})), [data]);

  const {columns, rows} = useMemo(() => {
    if (!body) return {columns: [], rows: []};
    const grouped = body.axis === 'partner-distribution';
    const cols = [{key: 'label', label: body.axisLabel === '合計' ? '区分' : body.axisLabel, type: 'text', sticky: true, width: 22, total: 'none'}];
    if (grouped) cols.push({key: 'groupLabel', label: '取引先', type: 'text', hidden: true});
    body.months.forEach((month, index) => {
      cols.push({
        key: `m${index}`, label: `${shortMonth(month)}${index === 0 || month.endsWith('-01') ? `（${month.slice(0, 4)}）` : ''}`, type: 'yen', total: 'sum',
        render: (row) => {
          const value = row[`m${index}`];
          if (body.future[index] && !value) return <span className="dg-muted" title="未到来の月">—</span>;
          if (!value) return <span className="dg-muted" aria-label="0">—</span>;
          return (
            <button type="button" className="rp-cell" title={`${monthText(month)}の元明細を開く`}
              onClick={() => { setDrill((previous) => ({...previous, [row.key]: month})); setExpandRequest((previous) => ({key: row.key, nonce: (previous?.nonce || 0) + 1})); }}>{int(value)}</button>
          );
        },
      });
    });
    body.quarters.forEach((label, index) => cols.push({key: `q${index}`, label, type: 'yen', total: 'sum'}));
    body.halves.forEach((label, index) => cols.push({key: `h${index}`, label, type: 'yen', total: 'sum'}));
    cols.push({key: 'total', label: '期間計', type: 'yen', total: 'sum'});
    cols.push({key: 'share', label: '構成比', type: 'rate', total: 'none', value: (row) => (row.share == null ? '—' : row.share)});
    cols.push({key: 'prevTotal', label: '前年同期', type: 'yen', total: 'sum'});
    cols.push({key: 'yoy', label: '前年比', type: 'rate', total: 'none', value: (row) => (row.yoy == null ? '—' : row.yoy + 1)});
    const list = body.rows.map((row) => ({
      key: row.key, keys: row.keys, labels: row.labels, label: row.label, groupLabel: row.groupLabel, total: row.total, share: row.share, prevTotal: row.prevTotal, yoy: row.yoy,
      ...Object.fromEntries(row.values.map((value, index) => [`m${index}`, value])),
      ...Object.fromEntries(row.quarters.map((value, index) => [`q${index}`, value])),
      ...Object.fromEntries(row.halves.map((value, index) => [`h${index}`, value])),
    }));
    return {columns: cols, rows: list};
  }, [body]);

  const names = useMemo(() => ({
    work: Object.fromEntries(works.map((w) => [String(w.id), w.title])),
    partner: Object.fromEntries(partners.map((p) => [String(p.id), p.name])),
    distribution: Object.fromEntries(distributionOptions.map((d) => [d.value, d.label])),
  }), [works, partners, distributionOptions]);

  function sheets() {
    const conditions = describeConditions(values, CONDITIONS, {names, axisOptions: ANNUAL_AXES});
    const dataAsOf = body?.dataAsOf?.latestImportAt ? `最終取込 ${dateTimeJst(body.dataAsOf.latestImportAt)}（JST）` : '取込なし';
    const summary = gridSheetSpec({columns, rows, exportSpec: {name: '集計', title, conditions, dataAsOf}, groupBy: body?.axis === 'partner-distribution' ? 'groupLabel' : undefined});
    const lineColumns = [
      {key: 'accounting_month', label: '計上月', type: 'month'}, {key: 'sales_month', label: '販売月', type: 'month'},
      {key: 'sales_month_estimated', label: '販売月は推定', type: 'text', value: (r) => (r.sales_month_estimated ? '推定' : '')},
      {key: 'partner_name', label: '取引先', type: 'text'}, {key: 'work_title', label: '作品', type: 'text'},
      {key: 'product_sku', label: '商品コード', type: 'code'}, {key: 'product_name', label: '商品', type: 'text'},
      {key: 'distribution_label', label: '流通', type: 'text'}, {key: 'description', label: '内容', type: 'text'},
      {key: 'quantity', label: '数量', type: 'int', total: 'sum'}, {key: 'amount', label: '金額（配賦後）', type: 'yen', total: 'sum'},
      {key: 'report_key', label: '報告', type: 'code'}, {key: 'source_row', label: '原本行', type: 'int', total: 'none'},
      {key: 'id', label: '売上ID', type: 'id'},
    ];
    const lineRows = allLines?.rows || [];
    const linesSheet = {name: '元明細', title: `${title}の元明細`, conditions, dataAsOf, columns: lineColumns, rows: lineRows,
      totals: [{label: `合計（${lineRows.length}行）`, values: {amount: lineRows.reduce((s, r) => s + r.amount, 0), quantity: lineRows.reduce((s, r) => s + (r.quantity || 0), 0)}}],
      notes: allLines && allLines.count > lineRows.length ? [`明細は先頭${lineRows.length}件（全${allLines.count}件）。全件は売上明細の画面から出力してください。`] : [], freezeCols: 1};
    const check = {name: '照合', title: '照合', conditions, dataAsOf,
      columns: [{key: 'item', label: '項目', type: 'text'}, {key: 'value', label: '値', type: 'yen'}],
      rows: [
        {item: '帳票の合計（行の和）', value: body?.integrity?.reportTotal ?? null},
        {item: '明細の再集計', value: body?.integrity?.lineTotal ?? null},
        {item: '差額（0であること）', value: body?.integrity?.diff ?? null},
        {item: '元明細シートの合計', value: lineRows.reduce((s, r) => s + r.amount, 0)},
      ], totals: [], notes: [body?.scope || ''], freezeCols: 1};
    const conditionSheet = {name: '条件', title: '集計条件', conditions: [], columns: [{key: 'k', label: '条件', type: 'text'}, {key: 'v', label: '値', type: 'text'}],
      rows: [...conditions.map(([k, v]) => ({k, v})), {k: '年度', v: fiscal ? `${fiscal.fiscalStartMonth}月開始${fiscal.confirmed ? '' : '（解釈は未確認）'}` : ''}, {k: '基準の説明', v: body?.basisNote || ''}, {k: 'データ時点', v: dataAsOf}],
      totals: [], notes: [], freezeCols: 1};
    return [summary, linesSheet, check, conditionSheet];
  }

  const period = values.from && values.to ? `${values.from}〜${values.to}` : '';
  return (
    <section className="card rp-report" aria-label={title}>
      <header className="rp-head">
        <div>
          <h2>{title}</h2>
          <p className="rp-muted">{body?.basisNote || '計上月基準の税抜円。'}{values.tax === 'inc' ? '税込（作品配賦で按分）。' : ''}</p>
        </div>
        {body && <ReportOutputBar sheets={sheets} name={title} period={period} title={title} subtitle={values.periodLabel} />}
      </header>
      <ConditionBar conditions={CONDITIONS} values={values} works={works} partners={partners} distributionOptions={distributionOptions}
        axisOptions={ANNUAL_AXES} fiscalConfirmed={fiscal?.confirmed} />
      {state.error && <Notice error={state.error} />}
      {state.loading && !body && <p className="rp-muted" aria-busy="true">集計中…</p>}
      {body && (
        <>
          <div className="rp-meta">
            <span className={`rp-check ${body.integrity.diff === 0 ? 'is-ok' : 'is-bad'}`}>
              {body.integrity.diff === 0 ? '照合OK' : '照合NG'}: 帳票合計 {yen(body.integrity.reportTotal)} ＝ 明細の再集計 {yen(body.integrity.lineTotal)}（差 {yen(body.integrity.diff)}・{body.integrity.lineCount}明細）
            </span>
            <span>データ時点: {body.dataAsOf.latestImportAt ? `最終取込 ${dateTimeJst(body.dataAsOf.latestImportAt)}` : '取込なし'}（有効な報告 {body.dataAsOf.activeReports}件）</span>
            {body.estimatedSalesMonthLines > 0 && <span className="rp-warn">販売月は推定: {body.estimatedSalesMonthLines}明細（報告に販売月がないため販売期間の開始月で数えています）</span>}
          </div>
          <div className="rp-tiles">
            <div><span>期間計</span><strong>{yen(body.totals.total)}</strong></div>
            <div><span>前年同期</span><strong>{yen(body.totals.prevTotal)}</strong></div>
            <div><span>前年比</span><strong>{body.totals.yoy == null ? '—' : rate(body.totals.yoy + 1)}</strong></div>
            <div><span>明細数</span><strong>{body.integrity.lineCount.toLocaleString('ja-JP')}</strong></div>
          </div>
          <MonthChart months={body.months} values={body.totals.values} cumulative={body.totals.cumulative} future={body.future} />
          <DataGrid
            columns={columns} rows={rows} rowKey="key" groupBy={body.axis === 'partner-distribution' ? 'groupLabel' : undefined}
            subtotalLabel="小計" totalLabel="合計" persistKey={`annual-${body.axis}`} emptyText="この条件の売上はありません（0円と未受領は区別していません）"
            ariaLabel={title}
            expandRequest={expandRequest}
            renderDetail={(row) => <DrillRows row={row} axis={body.axis} month={drill[row.key] || null} query={query} request={request} onNavigate={onNavigate} onClearMonth={() => setDrill((previous) => ({...previous, [row.key]: null}))} />}
          />
          <p className="rp-muted">行を押すと、その行の元明細が直下に開きます。月の金額を押すと、その月の明細に絞ります。「—」は0円（未到来の月を含む）。{body.scope}</p>
        </>
      )}
    </section>
  );
}

export default AnnualSalesReport;
