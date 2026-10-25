// 収支の画面の月別収支（選択中の作品）。グラフと、合計行つきの表（金額は右寄せ・月は年つき）。
// 注意書きは画面の上の「作品収支」に1回だけ出すので、ここでは既定で出さない（単独で使うときは caution を渡す）。
// 流通別・期間指定・Excel の正式な作品別収支は帳票センターにあり、そこへのリンクを置く（同じ基準で開く）。
// basis: 計上（計上月）か入金（入金日・出金日の月。フェーズ1 #16）。項目の名前は accounting/work-income/work-income-view-model.mjs
import React, {useId, useMemo} from 'react';
import {useShell} from './shell/context.mjs';
import {DataGrid} from './ui/DataGrid.jsx';
import {yen} from './ui/format.mjs';
import {incomeRows, incomeTotals, monthAxisLabels, workPnlLinkParams} from './reports/work-pnl-model.mjs';
import {incomeLabels, INCOME_CAUTION} from './accounting/work-income/work-income-view-model.mjs';

export {INCOME_CAUTION};

const monthLabel = (value) => {
  const match = /^(\d{4})-(\d{2})$/.exec(value || '');
  return match ? `${Number(match[1])}年${Number(match[2])}月` : value;
};

export default function IncomeDashboard({monthly = [], selectedMonth = '', onSelectMonth, workTitle = '', workId, caution = false, onNavigate, basis = 'accrual'}) {
  const shell = useShell();
  const titleId = useId();
  const descriptionId = useId();
  const words = incomeLabels(basis);
  const rows = useMemo(() => incomeRows(monthly, {fillGaps: true}), [monthly]);
  const totals = useMemo(() => incomeTotals(rows), [rows]);
  const navigate = onNavigate || (shell.isFallback ? null : shell.navigate);
  const targetWork = workId ?? shell.workId ?? null;
  const cautionText = caution === true ? words.caution : typeof caution === 'string' ? caution : '';
  const reportLink = navigate
    ? (
      <p className="note">
        <button type="button" className="secondary" onClick={() => navigate('帳票センター', {...workPnlLinkParams(targetWork), basis: words.basis})}>帳票センターで作品別収支を見る</button>
        {' '}流通別・期間指定・未配賦の経費・Excel出力は帳票センターの「作品別収支」で扱います。
      </p>
    )
    : null;

  if (!rows.length) {
    return (
      <section className="income-visual card" aria-labelledby={titleId}>
        <h2 id={titleId}>月別収支</h2>
        <p className="note income-basis" data-basis={words.basis}>{words.heading}</p>
        <p className="empty">{words.empty}</p>
        {reportLink}
        {cautionText && <p className="income-caution">{cautionText}</p>}
      </section>
    );
  }

  const width = 920, height = 350, left = 76, right = 24, top = 28, bottom = 76;
  const chartWidth = width - left - right, chartHeight = height - top - bottom;
  const values = rows.flatMap((row) => [row.revenue, row.cost, row.profit]);
  const min = Math.min(0, ...values), dataMax = Math.max(0, ...values);
  const max = min === 0 && dataMax === 0 ? 1 : dataMax;
  const span = max - min;
  const y = (value) => top + (max - value) / span * chartHeight;
  const zeroY = y(0), groupWidth = chartWidth / rows.length;
  const barWidth = Math.max(5, Math.min(22, groupWidth / 5));
  const labels = monthAxisLabels(rows.map((row) => row.month), {every: rows.length <= 12});
  const series = [
    {key: 'revenue', label: words.revenue, className: 'income-revenue'},
    {key: 'cost', label: words.basis === 'cash' ? '出金' : '経費', className: 'income-cost'},
    {key: 'profit', label: '差引', className: 'income-profit'},
  ];
  const ticks = Array.from({length: 5}, (_, index) => min + span * index / 4).reverse();
  const columns = [
    {key: 'month', label: words.month, type: 'month', sticky: true,
      render: (row) => (
        <button type="button" className="income-month-button" style={{minHeight: 0, padding: '0 6px'}} aria-pressed={selectedMonth === row.month} onClick={() => onSelectMonth?.(row.month)}>
          {monthLabel(row.month)}
        </button>
      )},
    {key: 'revenue', label: words.revenue, type: 'yen', total: 'sum'},
    {key: 'cost', label: words.cost, type: 'yen', total: 'sum'},
    {key: 'profit', label: words.profit, type: 'yen', total: 'sum'},
  ];

  return (
    <section className="income-visual card" aria-labelledby={titleId}>
      <header className="section-head">
        <div>
          <h2 id={titleId}>月別収支</h2>
          <p className="note income-basis" data-basis={words.basis}>{words.heading}</p>
          <p className="note">{words.month}ごとに、{words.revenue}・{words.cost}・差引を表示します。{rows.length}か月の合計は {words.revenue} {yen(totals.revenue)}・{words.cost} {yen(totals.cost)}・差引 {yen(totals.profit)}。</p>
        </div>
        <div className="income-legend" aria-label="凡例">
          {series.map((item) => <span key={item.key}><i className={item.className} />{item.label}</span>)}
        </div>
      </header>
      <div className="income-chart-wrap">
        <svg className="income-chart" viewBox={`0 0 ${width} ${height}`} role="img" aria-labelledby={`${titleId} ${descriptionId}`}>
          <desc id={descriptionId}>{workTitle || '選択作品'}の月別売上、登録経費、差引（{labels[0]?.full}〜{labels.at(-1)?.full}）。負数はゼロ線より下に表示します。</desc>
          {ticks.map((tick, index) => (
            <g key={index}>
              <line className="income-grid" x1={left} x2={width - right} y1={y(tick)} y2={y(tick)} />
              <text className="income-axis-label" x={left - 10} y={y(tick) + 4} textAnchor="end">{new Intl.NumberFormat('ja-JP', {notation: 'compact'}).format(tick)}</text>
            </g>
          ))}
          <line className="income-zero" x1={left} x2={width - right} y1={zeroY} y2={zeroY} />
          {rows.map((row, rowIndex) => {
            const center = left + groupWidth * (rowIndex + 0.5);
            const label = labels[rowIndex];
            return (
              <g key={row.month} className={selectedMonth === row.month ? 'income-month selected' : 'income-month'} role="button" tabIndex="0"
                aria-label={`${label.full}を選択。売上${yen(row.revenue)}、経費${yen(row.cost)}、差引${yen(row.profit)}`}
                onClick={() => onSelectMonth?.(row.month)}
                onKeyDown={(event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); onSelectMonth?.(row.month); } }}>
                {series.map((item, seriesIndex) => {
                  const value = row[item.key], valueY = y(value), barY = Math.min(zeroY, valueY), barHeight = value === 0 ? 0 : Math.max(1, Math.abs(zeroY - valueY));
                  return <rect key={item.key} className={`${item.className}${value < 0 ? ' negative' : ''}`} x={center + (seriesIndex - 1) * barWidth - barWidth * 0.4} y={barY} width={barWidth * 0.8} height={barHeight}><title>{`${label.full} ${item.label} ${yen(value)}`}</title></rect>;
                })}
                <text className="income-month-label" x={center} y={height - bottom + 26} textAnchor="middle">{label.month}</text>
                {label.year && <text className="income-month-label" x={center} y={height - bottom + 42} textAnchor="middle">{label.year}</text>}
              </g>
            );
          })}
        </svg>
      </div>
      <div className="income-table">
        <DataGrid columns={columns} rows={rows} rowKey="month" totalLabel="合計" persistKey="income-monthly" maxHeight="50vh"
          onRowClick={(row) => onSelectMonth?.(row.month)} ariaLabel={`${workTitle || '選択作品'}の月別収支`}
          exportSpec={{name: `月別収支_${workTitle || '作品'}`, title: `${workTitle || '選択作品'} 月別収支`, conditions: [['作品', workTitle || '選択作品'], ['基準', words.heading.replace(/^基準: /, '')]], notes: [words.caution]}} />
      </div>
      {reportLink}
      {cautionText && <p className="income-caution">{cautionText}</p>}
    </section>
  );
}
