// MG売上報告（台帳ベース）。MG契約ごとに、基準月時点の実充当・未消化残高・超過・計上と、取引先別の集計を1つの帳票で出す。
// 正本の「MG集計帳票」（売上MGグループの算定）は契約方針が未確定のため、この帳票は登録済みのMG台帳からの現況報告とする。
import React, {useEffect, useMemo, useState} from 'react';
import {useShell} from '../shell/context.mjs';
import {DataGrid} from '../ui/DataGrid.jsx';
import {ReportOutputBar} from '../ui/ReportOutputBar.jsx';
import {Notice} from '../ui/Notice.jsx';
import {FormField} from '../ui/FormField.jsx';
import {gridSheetSpec} from '../ui/grid-model.mjs';
import {yen, rate, month as monthText} from '../ui/format.mjs';
import {DIRECTION_OPTIONS} from '../ui/condition-model.mjs';
import {partyRows, detailRows, ledgerRows, reconcile} from './mg-sales-model.mjs';
import {IssuePanel} from './IssuePanel.jsx';
import './reports.css';

const PARTY_COLUMNS = [
  {key: 'partyName', label: '取引先', type: 'text', sticky: true},
  {key: 'contractCount', label: '契約数', type: 'int', total: 'sum'},
  {key: 'guaranteeYen', label: 'MG保証額', type: 'yen', total: 'sum'},
  {key: 'currentApplied', label: '当月の実充当', type: 'yen', total: 'sum'},
  {key: 'cumulativeApplied', label: '累計の実充当', type: 'yen', total: 'sum'},
  {key: 'remainingApplied', label: '未消化残高', type: 'yen', total: 'sum'},
  {key: 'exceedApplied', label: '保証額を超えた充当', type: 'yen', total: 'sum'},
  {key: 'currentRecognized', label: '当月の計上', type: 'yen', total: 'sum'},
  {key: 'cumulativeRecognized', label: '累計の計上', type: 'yen', total: 'sum'},
  {key: 'appliedRate', label: '到達率', type: 'rate', total: 'none', value: (row) => (row.appliedRate == null ? '—' : row.appliedRate)},
];

const DETAIL_COLUMNS = [
  {key: 'partyName', label: '取引先', type: 'text', sticky: true},
  {key: 'contractCode', label: '契約', type: 'code'},
  {key: 'contractTitle', label: '契約名', type: 'text', hidden: true},
  {key: 'termVersion', label: '条件の版', type: 'int', total: 'none', hidden: true},
  {key: 'workName', label: '作品', type: 'text'},
  {key: 'productLabel', label: '商品', type: 'text'},
  {key: 'guaranteeYen', label: 'MG保証額（契約）', type: 'yen', total: 'not-summable'},
  {key: 'priorApplied', label: '前月までの実充当', type: 'yen', total: 'sum'},
  {key: 'currentApplied', label: '当月の実充当', type: 'yen', total: 'sum'},
  {key: 'cumulativeApplied', label: '累計の実充当', type: 'yen', total: 'sum'},
  {key: 'remainingApplied', label: '未消化残高（契約）', type: 'yen', total: 'not-summable'},
  {key: 'currentOverage', label: '当月の超過報告', type: 'yen', total: 'sum'},
  {key: 'cumulativeOverage', label: '累計の超過報告', type: 'yen', total: 'sum'},
  {key: 'currentRecognized', label: '当月の計上', type: 'yen', total: 'sum'},
  {key: 'cumulativeRecognized', label: '累計の計上', type: 'yen', total: 'sum'},
  {key: 'currentEligible', label: '当月の消化対象', type: 'yen', total: 'sum', hidden: true},
  {key: 'cumulativeEligible', label: '累計の消化対象', type: 'yen', total: 'sum', hidden: true},
  {key: 'reachedMonth', label: '到達月（契約）', type: 'text', total: 'none'},
  {key: 'status', label: '状態（契約）', type: 'text', total: 'none'},
];

const LEDGER_COLUMNS = [
  {key: 'accountingMonth', label: '計上月', type: 'month', sticky: true},
  {key: 'partyName', label: '取引先', type: 'text'},
  {key: 'contractCode', label: '契約', type: 'code'},
  {key: 'productLabel', label: '商品', type: 'text'},
  {key: 'periodFrom', label: '対象期間の開始', type: 'date'},
  {key: 'periodTo', label: '対象期間の終了', type: 'date'},
  {key: 'sourceReference', label: '元資料', type: 'text'},
  {key: 'eligible', label: '消化対象', type: 'yen', total: 'sum'},
  {key: 'applied', label: '実充当', type: 'yen', total: 'sum'},
  {key: 'overage', label: '超過報告', type: 'yen', total: 'sum'},
  {key: 'recognized', label: '計上', type: 'yen', total: 'sum'},
  {key: 'status', label: '確認', type: 'text'},
  {key: 'reverses', label: '訂正', type: 'text'},
];

export function MgSalesReport({onNavigate}) {
  const shell = useShell();
  const request = shell.request;
  const direction = shell.getParam('direction', 'incoming') === 'outgoing' ? 'outgoing' : 'incoming';
  const [months, setMonths] = useState(null);
  const requestedMonth = shell.getParam('month', '');
  const party = shell.getParam('party', '');
  const [state, setState] = useState({loading: true});
  const [ledgerScope, setLedgerScope] = useState('until');

  useEffect(() => {
    let live = true;
    setMonths(null);
    request(`/reports/mg-sales/months?direction=${direction}`).then((body) => live && setMonths(body.months)).catch((error) => live && setState({error}));
    return () => { live = false; };
  }, [direction, request]);

  const month = requestedMonth || months?.[0]?.month || '';
  useEffect(() => {
    if (!month) { if (months) setState({empty: true}); return undefined; }
    let live = true;
    setState((previous) => ({...previous, loading: true, error: null}));
    const query = new URLSearchParams({direction, month});
    if (party) query.set('partyId', party);
    request(`/rights-reports/mg-portfolio?${query}`).then((body) => live && setState({report: body.report})).catch((error) => live && setState({error}));
    return () => { live = false; };
  }, [direction, month, party, months, request]);

  const report = state.report;
  const parties = useMemo(() => partyRows(report), [report]);
  const details = useMemo(() => detailRows(report), [report]);
  const ledger = useMemo(() => ledgerRows(report), [report]);
  const checks = useMemo(() => (report ? reconcile(report) : []), [report]);
  const directionLabel = DIRECTION_OPTIONS.find((option) => option.value === direction)?.label;
  const monthOptions = (months || []).map((m) => ({value: m.month, label: `${monthText(m.month)}（台帳${m.entries}行）`}));
  const partyOptions = [...new Map((report?.parties || []).map((p) => [String(p.id), p.name])).entries()].map(([value, label]) => ({value, label}));
  const title = `MG売上報告（${direction === 'incoming' ? '受取MG' : '支払MG'}）`;

  function sheets() {
    const conditions = [['MGの向き', directionLabel], ['基準月', monthText(month)], ['取引先', party ? partyOptions.find((p) => p.value === party)?.label || party : '全取引先']];
    const dataAsOf = report?.generatedAt;
    const cover = {name: '表紙', title, conditions, dataAsOf, columns: [{key: 'k', label: '項目', type: 'text'}, {key: 'v', label: '内容', type: 'text', wrap: true, width: 80}],
      rows: [
        {k: 'MG保証額の合計（契約ごとに1回）', v: yen(report.totals.guaranteeYen)}, {k: '累計の実充当', v: yen(report.totals.cumulative.appliedYen)},
        {k: '未消化残高', v: yen(report.totals.remainingAppliedYen)}, {k: '保証額を超えた充当', v: yen(report.totals.exceedAppliedYen)},
        {k: '累計の計上', v: yen(report.totals.cumulative.recognizedYen)}, {k: '到達率（実充当÷保証額）', v: report.totals.appliedRate == null ? '—' : rate(report.totals.appliedRate)},
        {k: '条件の版の選び方', v: report.versionPolicy}, {k: '到達月の定義', v: report.reachPolicy},
        ...report.warnings.map((w, i) => ({k: i === 0 ? '注意' : '', v: w})),
        {k: 'この帳票の範囲', v: '登録済みのMG台帳からの現況報告。正本の「MG集計帳票」（売上MGグループの算定）は契約方針が未確定のため含まない'},
      ], freezeCols: 1};
    return [
      cover,
      gridSheetSpec({columns: PARTY_COLUMNS, rows: parties, exportSpec: {name: '取引先別', title: `${title} 取引先別`, conditions, dataAsOf}}),
      gridSheetSpec({columns: DETAIL_COLUMNS.map((c) => ({...c, hidden: false})), rows: details, exportSpec: {name: '明細', title: `${title} 契約・作品・商品別`, conditions, dataAsOf,
        notes: ['「（契約）」の列は契約の先頭行だけに記載し、合計しません（合計不可）。MG保証額の合計は表紙を参照。']}}),
      gridSheetSpec({columns: LEDGER_COLUMNS, rows: ledger, exportSpec: {name: '台帳', title: `${title} 元の台帳`, conditions, dataAsOf}}),
      {name: '照合', title: '照合', conditions, dataAsOf, columns: [{key: 'item', label: '項目', type: 'text'}, {key: 'value', label: '金額', type: 'yen'}], rows: checks, freezeCols: 1},
    ];
  }

  const ledgerFor = (row) => ledger.filter((entry) => entry.contractId === row.contractId && entry.productId === row.productId
    && (ledgerScope === 'all' || (ledgerScope === 'until' ? entry.accountingMonth <= month : entry.accountingMonth === month)));

  return (
    <section className="card rp-report" aria-label={title}>
      <header className="rp-head">
        <div>
          <h2>{title}</h2>
          <p className="rp-muted">MG契約ごとに、基準月までの台帳から実充当・未消化残高・超過・計上を集計します。登録済みのMG台帳からの現況報告です（売上MGグループの算定は契約方針の確定待ち）。</p>
        </div>
        {report && <ReportOutputBar sheets={sheets} name={title} period={month} title={title} subtitle={`${directionLabel}・基準月 ${monthText(month)}`} formats={['xlsx', 'print', 'html', 'csv']} />}
      </header>
      <section className="on-conditions" aria-label="帳票の条件">
        <div className="on-field">
          <span className="on-field-label">MGの向き</span>
          <div className="on-segmented" role="group" aria-label="MGの向き">
            {DIRECTION_OPTIONS.map((option) => (
              <button key={option.value} type="button" aria-pressed={direction === option.value}
                onClick={() => { shell.setParam('direction', option.value); shell.setParam('month', null); shell.setParam('party', null); }}>{option.label}</button>
            ))}
          </div>
        </div>
        <FormField type="select" label="基準月" value={month} includeBlank={false} options={monthOptions.length ? monthOptions : [{value: '', label: '台帳がありません'}]}
          onChange={(value) => shell.setParam('month', value)} hint="台帳に明細がある月（新しい順）" />
        <FormField type="select" label="取引先" value={party} blankLabel="全取引先" options={partyOptions} onChange={(value) => shell.setParam('party', value || null)} />
        <p className="on-conditions-rule">Excelも画面と同じ取引先の絞込で出力します。</p>
      </section>
      {state.error && <Notice error={state.error} />}
      {state.empty && <Notice tone="info" message={`${directionLabel}の台帳がまだありません。「MG契約・台帳」で契約と台帳を登録すると、ここに報告が出ます。`}
        actions={onNavigate ? <button type="button" className="secondary" onClick={() => onNavigate('MG契約・台帳')}>MG契約・台帳を開く</button> : null} />}
      {state.loading && !report && !state.empty && <p className="rp-muted" aria-busy="true">集計中…</p>}
      {report && (
        <>
          <div className="rp-tiles">
            <div><span>MG保証額（契約ごとに1回）</span><strong>{yen(report.totals.guaranteeYen)}</strong></div>
            <div><span>累計の実充当</span><strong>{yen(report.totals.cumulative.appliedYen)}</strong></div>
            <div><span>未消化残高</span><strong>{yen(report.totals.remainingAppliedYen)}</strong></div>
            <div><span>保証額を超えた充当</span><strong>{yen(report.totals.exceedAppliedYen)}</strong></div>
            <div><span>累計の計上</span><strong>{yen(report.totals.cumulative.recognizedYen)}</strong></div>
            <div><span>到達率</span><strong>{report.totals.appliedRate == null ? '—' : rate(report.totals.appliedRate)}</strong></div>
          </div>
          <div className="rp-meta">
            {checks[2].value === 0 && checks[6].value === 0
              ? <span className="rp-check is-ok">照合OK: 累計実充当＝台帳の和、未消化残高＝保証額−累計実充当</span>
              : <span className="rp-check is-bad">照合NG: 明細と台帳の差 {yen(checks[2].value)}・残高の差 {yen(checks[6].value)}</span>}
            <span>{report.contracts.length}契約{report.notStartedCount ? `（基準月までに開始していない${report.notStartedCount}契約は対象外）` : ''}</span>
            {report.totals.unverifiedCount > 0 && <span className="rp-warn">未確認の台帳行 {report.totals.unverifiedCount}件</span>}
          </div>
          <h3 className="rp-group-title">取引先別</h3>
          <DataGrid columns={PARTY_COLUMNS} rows={parties} rowKey="key" persistKey="mg-sales-parties" emptyText="この条件のMG契約はありません" />
          <h3 className="rp-group-title">契約・作品・商品別（行を押すと台帳）</h3>
          <div className="rp-filter" role="group" aria-label="台帳の期間">
            {[['until', '基準月まで'], ['month', '基準月のみ'], ['all', '全期間']].map(([key, label]) => (
              <button key={key} type="button" className="text" aria-pressed={ledgerScope === key} onClick={() => setLedgerScope(key)}>台帳: {label}</button>
            ))}
          </div>
          <DataGrid columns={DETAIL_COLUMNS} rows={details} rowKey="key" persistKey="mg-sales-detail" emptyText="この条件の明細はありません"
            renderDetail={(row) => {
              const entries = ledgerFor(row);
              return (
                <div className="rp-drill">
                  <p className="rp-drill-head"><strong>{row.contractCode}・{row.productLabel}</strong> の台帳 {entries.length}行</p>
                  <DataGrid columns={LEDGER_COLUMNS} rows={entries} rowKey="key" maxHeight="300px" emptyText="この期間の台帳行はありません" />
                </div>
              );
            }} />
          <p className="rp-muted">「（契約）」の列は契約の先頭行だけに表示し、合計欄は「合計不可」です。MG保証額の正しい合計（契約ごとに1回）は上の枠に出しています。{report.versionPolicy}</p>
          <IssuePanel kind="mg-sales" conditions={{direction, month, partyId: party}} recipientName={partyOptions.find((p) => p.value === party)?.label} />
        </>
      )}
    </section>
  );
}

export default MgSalesReport;
