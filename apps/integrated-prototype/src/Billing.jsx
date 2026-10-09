// 請求・入金（作品ごと）。請求の一覧を表で出し、行を押すとその直下に請求書・入金の履歴・操作を開く。
// - 入金の登録は billing/ReceiptForm.jsx（月別入金表と同じ部品）。複数請求へ配分でき、二重登録を止める。
// - 請求の取消・入金の取消は取り消せない記録なので、その場で2段で確かめる（「内容を確認」→「この内容で取り消す／戻って直す」）。
// - 状態は色＋文字（期日超過n日・一部入金・入金済み・取消済み・請求日前）。成否は Notice の tone で示す。
// 表の行・状態の論理は billing/receipt-model.mjs（node で試験）。
import React, {useCallback, useEffect, useId, useMemo, useRef, useState} from 'react';
import {TaxInvoice} from './TaxLedger.jsx';
import {useShell} from './shell/context.mjs';
import {DataGrid} from './ui/DataGrid.jsx';
import {FormField} from './ui/FormField.jsx';
import {Notice} from './ui/Notice.jsx';
import {ReportOutputBar} from './ui/ReportOutputBar.jsx';
import {gridSheetSpec} from './ui/grid-model.mjs';
import {yen, int, dateJst} from './ui/format.mjs';
import {ReceiptForm, GridDetailFrame} from './billing/ReceiptForm.jsx';
import {billingInvoiceRows, billingSummary, receiptHistoryRows, todayJst} from './billing/receipt-model.mjs';
import './reports/reports.css';
import './tax.css';

const DATE = /^\d{4}-\d{2}-\d{2}$/;

export function StateChip({state}) {
  if (!state) return null;
  return <span className={`bl-state is-${state.tone || 'info'}`}>{state.label}</span>;
}

// 取り消せない操作（請求の取消・入金の取消）の2段の確認。onSubmit({date, reason}) が失敗したら理由を出す。
export function CancelRecordForm({title, dateLabel, minDate, defaultDate, warning, summary, confirmLabel, onSubmit, onClose, readOnly}) {
  const shell = useShell();
  const [values, setValues] = useState({date: defaultDate, reason: ''});
  const [step, setStep] = useState('input');
  const [errors, setErrors] = useState({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const unsavedId = `cancel${useId().replace(/:/g, '')}`;
  const register = shell.registerUnsaved;
  const dirty = values.reason.trim() !== '';
  useEffect(() => { register?.(unsavedId, dirty ? 1 : 0, title); }, [dirty, unsavedId, register, title]);
  useEffect(() => () => register?.(unsavedId, 0, title), [unsavedId, register]); // eslint-disable-line react-hooks/exhaustive-deps

  function review() {
    const found = {};
    if (!DATE.test(values.date || '')) found.date = `${dateLabel}を入力してください`;
    else if (minDate && values.date < minDate) found.date = `${dateLabel}は${dateJst(minDate)}以後にしてください`;
    if (!values.reason.trim()) found.reason = '理由を入力してください（記録に残ります）';
    setErrors(found);
    if (!Object.keys(found).length) { setError(null); setStep('confirm'); }
  }

  async function submit() {
    if (busy || readOnly) return;
    setBusy(true);
    setError(null);
    try {
      await onSubmit({date: values.date, reason: values.reason.trim()});
    } catch (cause) {
      setError(cause);
      setStep('input');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="bl-cancel-form" role="group" aria-label={title}>
      <h4>{title}</h4>
      {step === 'input' ? (
        <>
          {warning && <p className="rp-muted">{warning}</p>}
          <div className="on-form-grid">
            <FormField type="date" label={dateLabel} required value={values.date} onChange={(date) => setValues((previous) => ({...previous, date}))} error={errors.date} />
            <FormField label="理由" required wide value={values.reason} maxLength={1000} onChange={(reason) => setValues((previous) => ({...previous, reason}))} error={errors.reason} />
          </div>
          <div className="on-form-actions">
            <button type="button" onClick={review} disabled={readOnly}>内容を確認</button>
            <button type="button" className="secondary" onClick={onClose}>閉じる</button>
            {readOnly && <span className="rp-muted">確認専用の表示では記録できません。</span>}
          </div>
        </>
      ) : (
        <>
          <Notice tone="warn" title="この内容で記録します" message={summary(values)} />
          <div className="on-form-actions">
            <button type="button" onClick={submit} disabled={busy || readOnly}>{busy ? '記録しています…' : confirmLabel}</button>
            <button type="button" className="secondary" onClick={() => setStep('input')} disabled={busy}>戻って直す</button>
          </div>
        </>
      )}
      {error && <Notice error={error} />}
    </div>
  );
}

export default function Billing({data, request: requestProp, onNavigate}) {
  const shell = useShell();
  const request = requestProp || shell.request;
  const readOnly = Boolean(shell.readOnly || request?.readOnly);
  const navigate = onNavigate || shell.navigate;
  const workId = data?.selectedWorkId ?? null;
  const workTitle = data?.works?.find((work) => work.id === workId)?.title || '選択中の作品';

  const [localAsOf, setLocalAsOf] = useState(todayJst);
  const urlAsOf = shell.getParam('asOf', null);
  const asOf = DATE.test(urlAsOf || '') ? urlAsOf : localAsOf;
  const setAsOf = (value) => {
    if (!DATE.test(value || '')) return;
    setLocalAsOf(value);
    shell.setParam('asOf', value === todayJst() ? null : value, {replace: true});
  };

  const [state, setState] = useState({loading: true, body: null, error: null});
  const [notice, setNotice] = useState(null);
  const [detail, setDetail] = useState(null); // {invoiceId, mode: null | 'receipt' | 'void' | 'reverse', receiptId}
  const [expand, setExpand] = useState(null);
  const [preview, setPreview] = useState(null); // {invoiceId, html, loading, error}
  const [receiptOpen, setReceiptOpen] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);
  const seq = useRef(0);
  const frame = useRef(null);
  const scope = useRef(workId);
  scope.current = workId;

  const load = useCallback(async () => {
    if (!workId) return;
    const id = ++seq.current;
    setState((previous) => ({...previous, loading: true, error: null}));
    try {
      const body = await request(`/billing?workId=${workId}&asOf=${asOf}`);
      if (id === seq.current) setState({loading: false, body, error: null});
    } catch (error) {
      if (id === seq.current) setState((previous) => ({loading: false, body: previous.body, error}));
    }
  }, [request, workId, asOf]);

  useEffect(() => {
    setState({loading: true, body: null, error: null});
    setDetail(null);
    setPreview(null);
    setNotice(null);
    setReceiptOpen(false);
  }, [workId]);
  useEffect(() => { load(); }, [load]);

  const body = state.body;
  const rows = useMemo(() => billingInvoiceRows(body), [body]);
  const summary = useMemo(() => billingSummary(rows), [rows]);
  const history = useMemo(() => receiptHistoryRows(rows), [rows]);
  const eligibleReports = (body?.candidates || []).filter((row) => row.eligible).length;

  function openDetail(row, mode, extra = {}) {
    setDetail({invoiceId: row.invoiceId, mode, ...extra});
    setExpand((previous) => ({key: row.key, nonce: (previous?.nonce || 0) + 1}));
  }

  async function showInvoice(row) {
    setExpand((previous) => ({key: row.key, nonce: (previous?.nonce || 0) + 1}));
    if (preview?.invoiceId === row.invoiceId && preview.html) { setPreview(null); return; }
    const forWork = scope.current;
    setPreview({invoiceId: row.invoiceId, loading: true});
    try {
      const response = await request(`/billing/invoices/${row.invoiceId}/html`, {raw: true});
      const html = await response.text();
      if (forWork === scope.current) setPreview({invoiceId: row.invoiceId, html});
    } catch (error) {
      if (forWork === scope.current) setPreview({invoiceId: row.invoiceId, error});
    }
  }

  async function downloadInvoice(row) {
    try {
      const response = await request(`/billing/invoices/${row.invoiceId}/html?download=1`, {raw: true});
      const blob = await response.blob();
      const link = document.createElement('a');
      link.href = URL.createObjectURL(blob);
      link.download = `${row.invoiceNumber}.html`;
      link.click();
      URL.revokeObjectURL(link.href);
    } catch (error) {
      setNotice({tone: 'error', error});
    }
  }

  function changed(message, invoiceId) {
    setNotice({tone: 'ok', message});
    setDetail(invoiceId ? {invoiceId, mode: null} : null);
    setRefreshKey((key) => key + 1);
    load();
  }

  async function voidInvoice(row, {date, reason}) {
    await request(`/billing/invoices/${row.invoiceId}/void`, {method: 'POST', headers: {'If-Match': String(row.version)}, body: JSON.stringify({voidedOn: date, reason})});
    changed(`${row.invoiceNumber}を取り消しました（取消日 ${dateJst(date)}）。元の売上報告は、あらためて請求を作成できます。`, row.invoiceId);
  }

  async function reverseReceipt(row, receipt, {date, reason}) {
    await request(`/billing/receipts/${receipt.receiptId}/reverse`, {method: 'POST', headers: {'If-Match': '1'}, body: JSON.stringify({reversedOn: date, reason})});
    const others = receipt.otherInvoices.length ? `（${receipt.otherInvoices.join('、')}への消込も外れました）` : '';
    changed(`入金（参照番号 ${receipt.reference}・入金日 ${dateJst(receipt.receivedOn)}）を取り消しました${others}。消し込んでいた請求の残高が戻ります。`, row.invoiceId);
  }

  function receiptRegistered({message}) {
    setNotice({tone: 'ok', message});
    setRefreshKey((key) => key + 1);
    load();
  }

  const invoiceColumns = [
    {key: 'invoiceNumber', label: '請求番号', type: 'code', sticky: true, width: 17},
    {key: 'partnerName', label: '取引先', type: 'text'},
    {key: 'stateLabel', label: '状態', type: 'text', render: (row) => <StateChip state={row.state} />},
    {key: 'invoiceDate', label: '請求日', type: 'date'},
    {key: 'dueDate', label: '支払期日', type: 'date'},
    {key: 'amount', label: '請求額（税込）', type: 'yen', total: 'sum', totalValue: (row) => (row.isVoid || row.state?.key === 'void' || row.state?.key === 'future' ? 0 : row.amount)},
    {key: 'paid', label: '入金済', type: 'yen', total: 'sum'},
    {key: 'balance', label: '残高', type: 'yen', total: 'sum', value: (row) => row.balance ?? 0, exportValue: (row) => row.balance,
      render: (row) => (row.balance ? int(row.balance) : <span className="dg-muted" title={row.balance === null ? '取消済み・請求日前の請求は残高に数えません' : undefined}>—</span>)},
    {key: 'actions', label: '操作', type: 'text', sortable: false, searchable: false, export: false, value: () => '',
      render: (row) => (
        <div className="bl-row-actions">
          <button type="button" className="secondary" onClick={() => showInvoice(row)}>{preview?.invoiceId === row.invoiceId && preview.html ? '請求書を閉じる' : '請求書を表示'}</button>
          {row.canReceive && <button type="button" className="secondary" onClick={() => openDetail(row, 'receipt')} disabled={readOnly}>入金を登録</button>}
        </div>
      )},
  ];
  const historyColumns = [
    {key: 'receivedOn', label: '入金日', type: 'date'},
    {key: 'partnerName', label: '取引先', type: 'text'},
    {key: 'reference', label: '参照番号', type: 'code'},
    {key: 'invoiceNumber', label: '消込先の請求', type: 'code'},
    {key: 'amount', label: '消込額', type: 'yen', total: 'sum', totalValue: (row) => (row.reversed ? 0 : row.amount)},
    {key: 'stateLabel', label: '状態', type: 'text'},
    {key: 'reversalReason', label: '取消の理由', type: 'text', wrap: true},
  ];
  const monthlyColumns = [
    {key: 'month', label: '月', type: 'month', sticky: true},
    {key: 'plannedReceipts', label: '入金予定（税込・支払期日の月）', type: 'yen', total: 'sum'},
    {key: 'actualReceipts', label: '入金実績（入金日の月・取消は負）', type: 'yen', total: 'sum'},
    {key: 'recognizedSalesExTax', label: '売上計上（税抜・計上月）', type: 'yen', total: 'sum'},
  ];
  const monthlyRows = body?.monthly || [];

  function renderDetail(row) {
    const mode = detail?.invoiceId === row.invoiceId ? detail.mode : null;
    const shown = preview?.invoiceId === row.invoiceId ? preview : null;
    return (
      <GridDetailFrame>
        <dl className="bl-detail-meta">
          <div><dt>税抜</dt><dd className="num">{yen(row.amountExTax)}</dd></div>
          <div><dt>税額</dt><dd className="num">{yen(row.taxAmount)}</dd></div>
          <div><dt>税込</dt><dd className="num">{yen(row.amount)}</dd></div>
          {row.voidedOn && <div><dt>取消</dt><dd>{dateJst(row.voidedOn)}・{row.voidReason}</dd></div>}
          {row.note && <div><dt>注記</dt><dd>{row.note}</dd></div>}
        </dl>
        <div className="bl-actions">
          <button type="button" onClick={() => showInvoice(row)}>{shown?.html ? '請求書を閉じる' : '請求書を表示'}</button>
          <button type="button" className="secondary" onClick={() => downloadInvoice(row)}>請求書をHTMLで保存</button>
          {row.canReceive && mode !== 'receipt' && <button type="button" className="secondary" onClick={() => openDetail(row, 'receipt')} disabled={readOnly}>この請求の入金を登録</button>}
          {row.canVoid && mode !== 'void' && <button type="button" className="secondary" onClick={() => openDetail(row, 'void')} disabled={readOnly}>請求を取り消す</button>}
        </div>
        {!row.canVoid && row.recordStatus === 'issued' && <p className="rp-muted">有効な入金がある請求は取り消せません。先に入金を取り消してください。</p>}
        {shown?.loading && <p className="rp-muted" aria-busy="true">請求書を読み込んでいます…</p>}
        {shown?.error && <Notice error={shown.error} onRetry={() => showInvoice(row)} />}
        {shown?.html && (
          <div className="document-preview bl-preview">
            <div className="bl-actions"><button type="button" className="secondary" onClick={() => frame.current?.contentWindow?.print()}>この請求書を印刷</button></div>
            <iframe ref={frame} title={`${row.invoiceNumber}の請求書`} srcDoc={shown.html} />
          </div>
        )}
        {mode === 'receipt' && (
          <ReceiptForm key={`receipt-${row.invoiceId}`} request={request} invoiceId={row.invoiceId} refreshKey={refreshKey} heading={`${row.invoiceNumber}の入金を登録`}
            onRegistered={(result) => { receiptRegistered(result); setDetail({invoiceId: row.invoiceId, mode: null}); }} onCancel={() => setDetail({invoiceId: row.invoiceId, mode: null})} />
        )}
        {mode === 'void' && (
          <CancelRecordForm key={`void-${row.invoiceId}`} title={`${row.invoiceNumber}の請求を取り消す`} dateLabel="取消日" minDate={row.invoiceDate} defaultDate={todayJst()} readOnly={readOnly}
            warning="請求の取消は削除ではなく、取消の記録を残します。取り消すと元の売上報告を別の請求にまとめ直せます。"
            summary={(values) => `${row.invoiceNumber}（${row.partnerName}・${yen(row.amount)}）を${dateJst(values.date)}付けで取り消します。理由: ${values.reason}。取り消した請求は元に戻せません。`}
            confirmLabel="この内容で取り消す" onSubmit={(values) => voidInvoice(row, values)} onClose={() => setDetail({invoiceId: row.invoiceId, mode: null})} />
        )}
        <div className="bl-table-wrap">
          <table className="bl-table">
            <caption>入金の履歴（{row.receipts.length}件）</caption>
            {row.receipts.length > 0 && (
              <thead><tr><th scope="col">入金日</th><th scope="col">参照番号</th><th scope="col" className="num">この請求への消込額</th><th scope="col">状態</th><th scope="col">操作</th></tr></thead>
            )}
            <tbody>
              {!row.receipts.length && <tr><td colSpan={5} className="rp-muted">まだ入金はありません。</td></tr>}
              {row.receipts.map((receipt) => (
                <React.Fragment key={receipt.receiptId}>
                  <tr>
                    <td>{dateJst(receipt.receivedOn)}</td>
                    <td>{receipt.reference}</td>
                    <td className="num">{int(receipt.amount)}</td>
                    <td>{receipt.reversedOn
                      ? <><span className="bl-state is-info">取消済み</span> {dateJst(receipt.reversedOn)}・{receipt.reversalReason}</>
                      : <span className="bl-state is-ok">有効</span>}
                      {receipt.otherInvoices.length > 0 && <div className="rp-muted">同じ入金の消込先: {receipt.otherInvoices.join('、')}</div>}
                    </td>
                    <td>{!receipt.reversedOn && <button type="button" className="secondary" disabled={readOnly} onClick={() => openDetail(row, 'reverse', {receiptId: receipt.receiptId})}>入金を取り消す</button>}</td>
                  </tr>
                  {mode === 'reverse' && detail.receiptId === receipt.receiptId && (
                    <tr><td colSpan={5}>
                      <CancelRecordForm key={`reverse-${receipt.receiptId}`} title={`入金（参照番号 ${receipt.reference}）の取消`} dateLabel="取消日" minDate={receipt.receivedOn} defaultDate={todayJst()} readOnly={readOnly}
                        warning={`入金の取消は削除ではなく、取消の記録を残します。この入金のすべての消込が外れます${receipt.otherInvoices.length ? `（${receipt.otherInvoices.join('、')}を含む）` : ''}。`}
                        summary={(values) => `入金日 ${dateJst(receipt.receivedOn)}・参照番号 ${receipt.reference} の入金を${dateJst(values.date)}付けで取り消します。理由: ${values.reason}。取り消した入金は元に戻せません（正しい入金はあらためて登録します）。`}
                        confirmLabel="この内容で取り消す" onSubmit={(values) => reverseReceipt(row, receipt, values)} onClose={() => setDetail({invoiceId: row.invoiceId, mode: null})} />
                    </td></tr>
                  )}
                </React.Fragment>
              ))}
            </tbody>
          </table>
        </div>
      </GridDetailFrame>
    );
  }

  const title = `請求・入金（${workTitle}）`;
  if (!workId) {
    return <section className="card"><Notice tone="info" message="作品がまだありません。作品を登録すると、その作品の請求と入金を扱えます。" /></section>;
  }

  return (
    <div className="stack billing">
      <section className="card rp-report" aria-label="請求・入金">
        <header className="rp-head">
          <div>
            <h2>請求と入金の状況</h2>
            <p className="rp-muted">{workTitle}の請求と入金。請求日・支払期日・入金日・売上計上月は別々の日付として扱います。入金は取引先ごとに、複数の請求へ配分して登録できます。</p>
          </div>
          {body && (
            <ReportOutputBar name="請求・入金" period={asOf} title={title} sheets={() => [
              gridSheetSpec({columns: invoiceColumns, rows, exportSpec: {name: '請求一覧', title, conditions: [['作品', workTitle], ['残高の基準日', asOf]]}}),
              gridSheetSpec({columns: historyColumns, rows: history, exportSpec: {name: '入金の履歴', title: `入金の履歴（${workTitle}）`, conditions: [['作品', workTitle]]}}),
              gridSheetSpec({columns: monthlyColumns, rows: monthlyRows, exportSpec: {name: '月別の予定と実績', title: `月別の入金予定・入金実績・売上計上（${workTitle}）`, conditions: [['作品', workTitle], ['基準日', asOf]],
                notes: ['入金予定は支払期日の月、入金実績は入金日の月（取消は取消日の月に負の額）、売上は計上月。同じ月でも意味が違うので足し合わせない。']}}),
            ]} />
          )}
        </header>
        <section className="on-conditions" aria-label="条件">
          <FormField type="date" label="残高の基準日" value={asOf} onChange={setAsOf} hint="この日までの入金で残高と状態を出します" />
        </section>
        <nav className="bl-links" aria-label="関連する画面">
          <span>関連:</span>
          <button type="button" className="secondary" onClick={() => navigate?.('月別消込')}>月別入金表</button>
          <button type="button" className="secondary" onClick={() => navigate?.('税ルール・台帳')}>税計算台帳</button>
          <button type="button" className="secondary" onClick={() => navigate?.('帳票センター', {report: 'receivables'})}>売掛金の一覧（帳票センター）</button>
          <button type="button" className="secondary" onClick={() => navigate?.('帳票センター', {report: 'partner-balance'})}>取引先別の売掛残高推移（帳票センター）</button>
        </nav>
        {body && (
          <div className="rp-tiles">
            <div><span>請求（{dateJst(asOf)}時点）</span><strong>{int(summary.count)}件</strong><small>うち残高あり {int(summary.openCount)}件</small></div>
            <div><span>売掛残高</span><strong>{yen(summary.balance)}</strong></div>
            <div className={summary.overdueCount ? 'is-warn' : undefined}><span>うち期日超過</span><strong>{yen(summary.overdue)}</strong><small>{summary.overdueCount ? `${int(summary.overdueCount)}件の請求` : '期日超過はありません'}</small></div>
            <div><span>請求できる売上報告</span><strong>{int(eligibleReports)}件</strong></div>
          </div>
        )}
      </section>
      {notice && <Notice tone={notice.tone} message={notice.message} error={notice.error} onDismiss={() => setNotice(null)} />}
      {state.error && <Notice error={state.error} onRetry={load} />}
      {!body && state.loading && <section className="card"><p className="rp-muted" aria-busy="true">請求・入金を読み込んでいます…</p></section>}
      {body && (
        <>
          <section className="card" aria-label="請求の一覧">
            <header className="section-head"><h3>請求の一覧</h3></header>
            <DataGrid columns={invoiceColumns} rows={rows} rowKey="key" persistKey="billing-invoices" renderDetail={renderDetail} expandRequest={expand}
              initialSort={{key: 'invoiceDate', dir: 'desc'}} ariaLabel="請求の一覧" maxHeight="none"
              emptyText={eligibleReports ? `請求はまだありません。下の「売上報告から請求を作成」で、請求できる売上報告（${eligibleReports}件）から作成できます。` : '請求はまだありません。'} />
          </section>
          <section className="card" aria-label="入金の登録">
            <header className="section-head">
              <div><h3>入金の登録</h3><p className="rp-muted">取引先からの1回の入金を、複数の請求へ配分して消し込みます。請求の行の「入金を登録」からも開けます。</p></div>
              {!receiptOpen && <button type="button" onClick={() => setReceiptOpen(true)} disabled={readOnly}>入金を登録</button>}
            </header>
            {receiptOpen && <ReceiptForm request={request} refreshKey={refreshKey} onRegistered={receiptRegistered} onCancel={() => setReceiptOpen(false)} />}
          </section>
          <section className="card" aria-label="売上報告から請求を作成">
            <header className="section-head">
              <div><h3>売上報告から請求を作成</h3><p className="rp-muted">税区分を明細ごとに確かめて税額を計算し、確認してから請求を確定します。確定した請求の元売上は変わりません。</p></div>
              <button type="button" className={createOpen ? 'secondary' : undefined} onClick={() => setCreateOpen((open) => !open)}>{createOpen ? '閉じる' : `請求を作成（請求できる報告 ${eligibleReports}件）`}</button>
            </header>
            {createOpen && <TaxInvoice key={workId} data={data} state={body} request={request} onCreated={() => { setNotice(null); load(); }} onNavigate={navigate} />}
          </section>
          <section className="card" aria-label="月別の入金予定・入金実績・売上計上">
            <header className="section-head"><div><h3>月別の入金予定・入金実績・売上計上</h3>
              <p className="rp-muted">入金予定は支払期日の月、入金実績は入金日の月（取消は取消日の月に負の額）、売上は計上月です。同じ月でも意味が違うので足し合わせません。</p></div></header>
            <DataGrid columns={monthlyColumns} rows={monthlyRows} rowKey="month" persistKey="billing-monthly" ariaLabel="月別の入金予定・入金実績・売上計上" emptyText="この作品の請求・入金・売上はまだありません。" />
          </section>
          {history.length > 0 && (
            <section className="card" aria-label="入金の履歴">
              <details className="bl-fold">
                <summary>入金の履歴（{int(history.length)}行）</summary>
                <DataGrid columns={historyColumns} rows={history} rowKey="key" persistKey="billing-receipts" ariaLabel="入金の履歴" />
              </details>
            </section>
          )}
        </>
      )}
    </div>
  );
}
