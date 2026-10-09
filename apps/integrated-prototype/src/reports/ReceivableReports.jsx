// 売掛の帳票。取引先別の売掛残高推移（前月残＋当月売上−当月入金＝当月残）と、請求書ごとの売掛金の一覧（期日超過・経過区分）。
import React, {useEffect, useMemo, useState} from 'react';
import {useShell} from '../shell/context.mjs';
import {useConditions, ConditionBar} from '../ui/ConditionBar.jsx';
import {DataGrid} from '../ui/DataGrid.jsx';
import {ReportOutputBar} from '../ui/ReportOutputBar.jsx';
import {Notice} from '../ui/Notice.jsx';
import {FormField} from '../ui/FormField.jsx';
import {gridSheetSpec} from '../ui/grid-model.mjs';
import {yen, month as monthText} from '../ui/format.mjs';
import './reports.css';

const CONDITIONS = ['fiscalYear', 'period'];

export function PartnerBalanceReport({fiscal, onNavigate}) {
  const shell = useShell();
  const values = useConditions(CONDITIONS, {fiscalStartMonth: fiscal?.fiscalStartMonth});
  const [state, setState] = useState({loading: true});
  useEffect(() => {
    if (!values.valid || !values.from) return undefined;
    let live = true;
    setState((previous) => ({...previous, loading: true, error: null}));
    shell.request(`/reports/partner-balance?from=${values.from}&to=${values.to}`).then((body) => live && setState({body})).catch((error) => live && setState({error}));
    return () => { live = false; };
  }, [values.from, values.to, values.valid, shell]);
  const body = state.body;
  const {columns, rows} = useMemo(() => {
    if (!body) return {columns: [], rows: []};
    const cols = [{key: 'partnerName', label: '取引先', type: 'text', sticky: true}, {key: 'opening', label: '期首残', type: 'yen', total: 'sum'}];
    body.months.forEach((m, i) => {
      cols.push({key: `s${i}`, label: `${monthText(m)} 売上`, type: 'yen', total: 'sum'});
      cols.push({key: `r${i}`, label: `${monthText(m)} 入金`, type: 'yen', total: 'sum'});
      cols.push({key: `b${i}`, label: `${monthText(m)} 残高`, type: 'yen', total: 'sum'});
    });
    cols.push({key: 'salesTotal', label: '期間の売上', type: 'yen', total: 'sum'}, {key: 'receiptTotal', label: '期間の入金', type: 'yen', total: 'sum'},
      {key: 'closing', label: '期末残', type: 'yen', total: 'sum'}, {key: 'unbilledAtEnd', label: 'うち未請求', type: 'yen', total: 'sum'});
    const list = body.rows.map((row) => ({...row, key: row.partnerId,
      ...Object.fromEntries(row.sales.map((v, i) => [`s${i}`, v])), ...Object.fromEntries(row.receipts.map((v, i) => [`r${i}`, v])), ...Object.fromEntries(row.balances.map((v, i) => [`b${i}`, v]))}));
    return {columns: cols, rows: list};
  }, [body]);
  const title = '取引先別の売掛残高推移';
  return (
    <section className="card rp-report" aria-label={title}>
      <header className="rp-head">
        <div>
          <h2>{title}</h2>
          <p className="rp-muted">前月残＋当月売上−当月入金＝当月残。売上は計上月・税込で数えるので、請求していない売上や入金と合わない請求が残高に残り、処理するまで消えません。</p>
        </div>
        {body && <ReportOutputBar name={title} period={`${values.from}〜${values.to}`} title={title} subtitle={values.periodLabel}
          sheets={() => [gridSheetSpec({columns, rows, exportSpec: {name: '残高推移', title, conditions: [['期間', values.periodLabel]], notes: [body.basis]}}),
            {name: '照合', title: '照合', columns: [{key: 'item', label: '項目', type: 'text'}, {key: 'value', label: '差額', type: 'yen'}], rows: body.checks, freezeCols: 1}]} />}
      </header>
      <ConditionBar conditions={CONDITIONS} values={values} fiscalConfirmed={fiscal?.confirmed} />
      {state.error && <Notice error={state.error} />}
      {body && (
        <>
          <div className="rp-tiles">
            <div><span>期首残</span><strong>{yen(body.totals.opening)}</strong></div>
            <div><span>期間の売上</span><strong>{yen(body.totals.salesTotal)}</strong></div>
            <div><span>期間の入金</span><strong>{yen(body.totals.receiptTotal)}</strong></div>
            <div><span>期末残</span><strong>{yen(body.totals.closing)}</strong></div>
            <div><span>うち未請求</span><strong>{yen(body.totals.unbilledAtEnd)}</strong></div>
          </div>
          <div className="rp-meta"><span className={`rp-check ${body.checks[0].value === 0 ? 'is-ok' : 'is-bad'}`}>{body.checks[0].value === 0 ? '照合OK: 期首残＋売上−入金＝期末残' : `照合NG: 差 ${yen(body.checks[0].value)}`}</span><span>{body.basis}</span></div>
          <DataGrid columns={columns} rows={rows} rowKey="key" persistKey="partner-balance" emptyText="この期間の売上・入金はありません" />
          {onNavigate && <div className="on-form-actions"><button type="button" className="secondary" onClick={() => onNavigate('売上', {billing: 'unbilled'})}>未請求の売上明細を見る</button><button type="button" className="secondary" onClick={() => onNavigate('帳票センター', {report: 'receivables'})}>売掛金の一覧（請求書ごと）を見る</button></div>}
        </>
      )}
      {state.loading && !body && <p className="rp-muted" aria-busy="true">集計中…</p>}
    </section>
  );
}

const RECEIVABLE_COLUMNS = [
  {key: 'partnerName', label: '取引先', type: 'text', sticky: true},
  {key: 'invoiceNumber', label: '請求番号', type: 'code'},
  {key: 'invoiceDate', label: '請求日', type: 'date'},
  {key: 'dueDate', label: '支払期日', type: 'date'},
  {key: 'plannedDate', label: '入金予定日（期日超過の基準）', type: 'date'},
  {key: 'amount', label: '請求額（税込）', type: 'yen', total: 'sum', totalValue: (row) => (row.status === '取消済み' ? 0 : row.amount)},
  {key: 'received', label: '入金済', type: 'yen', total: 'sum'},
  {key: 'balance', label: '残高', type: 'yen', total: 'sum'},
  {key: 'status', label: '状態', type: 'text'},
  {key: 'aging', label: '経過区分', type: 'text'},
];

export function ReceivablesReport({onNavigate}) {
  const shell = useShell();
  const today = new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10);
  const asOf = shell.getParam('asOf', today);
  const onlyOpen = shell.getParam('open', '1') === '1';
  const [state, setState] = useState({loading: true});
  useEffect(() => {
    let live = true;
    setState((previous) => ({...previous, loading: true, error: null}));
    shell.request(`/billing/receivables?asOf=${asOf}`).then((body) => live && setState({body})).catch((error) => live && setState({error}));
    return () => { live = false; };
  }, [asOf, shell]);
  const body = state.body;
  const rows = (body?.rows || []).filter((row) => !onlyOpen || row.open);
  const title = '売掛金の一覧（請求書ごと）';
  return (
    <section className="card rp-report" aria-label={title}>
      <header className="rp-head">
        <div>
          <h2>{title}</h2>
          <p className="rp-muted">基準日時点の入金済・残高と、支払期日からの経過日数。期日を過ぎた未入金は上に並びます。</p>
        </div>
        {body && <ReportOutputBar name="売掛金の一覧" period={asOf} title={title} sheets={() => [gridSheetSpec({columns: RECEIVABLE_COLUMNS, rows, exportSpec: {name: '売掛金', title, conditions: [['基準日', asOf], ['対象', onlyOpen ? '残高のある請求だけ' : 'すべての請求']]}})]} />}
      </header>
      <section className="on-conditions" aria-label="条件">
        <FormField type="date" label="基準日" value={asOf} onChange={(value) => value && shell.setParam('asOf', value)} />
        <FormField type="select" label="対象" value={onlyOpen ? '1' : '0'} includeBlank={false} options={[{value: '1', label: '残高のある請求だけ'}, {value: '0', label: 'すべての請求'}]} onChange={(value) => shell.setParam('open', value)} />
      </section>
      {state.error && <Notice error={state.error} />}
      {body && (
        <>
          <div className="rp-tiles">
            <div><span>残高のある請求</span><strong>{body.totals.open}件</strong></div>
            <div><span>売掛残高</span><strong>{yen(body.totals.balance)}</strong></div>
            <div><span>うち期日超過</span><strong>{yen(body.totals.overdue)}</strong></div>
          </div>
          <DataGrid columns={RECEIVABLE_COLUMNS} rows={rows} rowKey="invoiceId" persistKey="receivables" emptyText="残高のある請求はありません" />
          {onNavigate && <div className="on-form-actions"><button type="button" className="secondary" onClick={() => onNavigate('請求・入金')}>請求・入金の画面で入金を登録する</button></div>}
        </>
      )}
      {state.loading && !body && <p className="rp-muted" aria-busy="true">読み込み中…</p>}
    </section>
  );
}
