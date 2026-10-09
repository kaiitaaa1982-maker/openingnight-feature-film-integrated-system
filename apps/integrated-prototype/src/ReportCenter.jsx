import {useEffect,useState} from 'react';
import './reporting.css';
// 流通別の販売条件（SalesCatalog）用。ほかの部品と名前がぶつからないよう名前空間で読む。
import * as ReactSC from 'react';
import * as ShellSC from './shell/context.mjs';
import * as GridSC from './ui/DataGrid.jsx';
import * as NoticeSC from './ui/Notice.jsx';
import * as FieldSC from './ui/FormField.jsx';
import * as LabelsSC from './ui/labels.mjs';
import * as FormatSC from './ui/format.mjs';
import * as CatalogSC from './sales-ops/sales-catalog-model.mjs';
import * as DraftSC from './broadcast-draft.mjs';
import * as PipelineSC from './sales-ops/pipeline-routes.mjs';
import * as ToneSC from './sales-ops/PipelineBoard.jsx';
import * as ReleaseSC from './sales/ReleaseMonthView.jsx';
import './reports/reports.css';
import './sales-ops/sales-ops.css';
const today=()=>new Date().toISOString().slice(0,10),yearStart=()=>`${new Date().getFullYear()}-01`;
const money=n=>Number(n||0).toLocaleString('ja-JP');
function Status({message}){return message?<p role="status">{message}</p>:null}
export {default} from './ReportSalesPanel.jsx';

// ---- 月別入金表（ReceiptSheet）----
// 請求×月の入金を表にする（入金のない月は空欄、取消は取消日の月に負の額）。状態は色＋文字（期日超過n日・一部入金など）。
// 行を押すと直下に入金・予定変更の履歴を開き、「入金を登録」は請求・入金と同じ ReceiptForm をその行の直下に出す。
// 予定変更の承認待ちは下の一覧で「承認」「却下」をその場で押せる（管理者）。行の組み立ては billing/receipt-model.mjs。
// ほかの部品（SalesCatalog）と名前がぶつからないよう名前空間で読む。
import * as ReactRS from 'react';
import * as ShellRS from './shell/context.mjs';
import * as GridRS from './ui/DataGrid.jsx';
import * as NoticeRS from './ui/Notice.jsx';
import * as FieldRS from './ui/FormField.jsx';
import * as OutputRS from './ui/ReportOutputBar.jsx';
import * as GridModelRS from './ui/grid-model.mjs';
import * as FormatRS from './ui/format.mjs';
import * as ConditionRS from './ui/condition-model.mjs';
import * as FiscalRS from './reports/use-fiscal.mjs';
import * as ReceiptRS from './billing/receipt-model.mjs';
import * as ReceiptFormRS from './billing/ReceiptForm.jsx';
import './tax.css';

const RS_DATE = /^\d{4}-\d{2}-\d{2}$/;

function RsStateChip({state}) {
  return state ? <span className={`bl-state is-${state.tone || 'info'}`}>{state.label}</span> : null;
}

// 入金予定の変更の申請（却下できる申請なので1段。承認後に入金予定日へ反映する）。
function RsPlanChangeForm({row, request, readOnly, onDone, onCancel}) {
  const [values, setValues] = ReactRS.useState({date: row.plannedDate, reason: ''});
  const [errors, setErrors] = ReactRS.useState({});
  const [error, setError] = ReactRS.useState(null);
  const [busy, setBusy] = ReactRS.useState(false);
  async function submit() {
    const found = {};
    if (!RS_DATE.test(values.date || '')) found.date = '変更後の入金予定日を入力してください';
    else if (values.date < row.invoiceDate) found.date = `請求日（${FormatRS.dateJst(row.invoiceDate)}）以後の日付にしてください`;
    else if (values.date === row.plannedDate) found.date = 'いまの入金予定日と違う日付にしてください';
    if (!values.reason.trim()) found.reason = '理由を入力してください（承認の判断に使います）';
    setErrors(found);
    if (Object.keys(found).length || busy || readOnly) return;
    setBusy(true);
    setError(null);
    try {
      await request('/receipt-plan/requests', {method: 'POST', body: JSON.stringify({invoiceId: row.invoiceId, baseVersion: row.planVersion, proposedDueDate: values.date, reason: values.reason.trim()})});
      onDone(`${row.invoiceNumber}の入金予定の変更（${FormatRS.dateJst(row.plannedDate)} → ${FormatRS.dateJst(values.date)}）を申請しました。管理者が承認すると、この表の入金予定日に反映します。`);
    } catch (cause) {
      setError(cause);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="bl-cancel-form" role="group" aria-label={`${row.invoiceNumber}の入金予定の変更`}>
      <h4>{row.invoiceNumber}の入金予定の変更を申請</h4>
      <p className="rp-muted">変わるのは残額の入金予定日だけです。請求書の支払期日と売上の計上月は変わりません。</p>
      <div className="on-form-grid">
        <FieldRS.FormField type="date" label="変更後の入金予定日" required value={values.date} onChange={(date) => setValues((previous) => ({...previous, date}))} error={errors.date} />
        <FieldRS.FormField label="理由" required wide maxLength={1000} value={values.reason} onChange={(reason) => setValues((previous) => ({...previous, reason}))} error={errors.reason} />
      </div>
      {error && <NoticeRS.Notice error={error} />}
      <div className="on-form-actions">
        <button type="button" onClick={submit} disabled={busy || readOnly}>{busy ? '申請しています…' : '変更を申請'}</button>
        <button type="button" className="secondary" onClick={onCancel} disabled={busy}>閉じる</button>
      </div>
    </div>
  );
}

// 承認待ちの申請に「承認」「却下」をその場で出す（理由は必須・記録に残る）。
function RsPlanDecision({item, request, readOnly, onDone}) {
  const [reason, setReason] = ReactRS.useState('');
  const [effectiveOn, setEffectiveOn] = ReactRS.useState(ReceiptRS.todayJst);
  const [errors, setErrors] = ReactRS.useState({});
  const [error, setError] = ReactRS.useState(null);
  const [busy, setBusy] = ReactRS.useState(null);
  async function decide(decision) {
    const found = {};
    if (!reason.trim()) found.reason = '承認・却下の理由を入力してください（記録に残ります）';
    if (decision === 'approved' && !RS_DATE.test(effectiveOn || '')) found.effectiveOn = '適用日を入力してください';
    setErrors(found);
    if (Object.keys(found).length || busy || readOnly) return;
    setBusy(decision);
    setError(null);
    try {
      await request(`/receipt-plan/requests/${item.id}/decide`, {method: 'POST', body: JSON.stringify({decision, effectiveOn, reason: reason.trim()})});
      onDone(decision === 'approved'
        ? `${item.invoiceNumber}の入金予定の変更を承認しました。入金予定日は${FormatRS.dateJst(item.proposedDueDate)}になります（適用日 ${FormatRS.dateJst(effectiveOn)}）。`
        : `${item.invoiceNumber}の入金予定の変更を却下しました。入金予定日は${FormatRS.dateJst(item.previousDueDate)}のままです。`);
    } catch (cause) {
      setError(cause);
    } finally {
      setBusy(null);
    }
  }
  return (
    <div className="rs-decision">
      <div className="on-form-grid">
        <FieldRS.FormField label="承認・却下の理由" required wide maxLength={1000} value={reason} onChange={setReason} error={errors.reason} />
        <FieldRS.FormField type="date" label="適用日（承認のとき）" value={effectiveOn} onChange={setEffectiveOn} error={errors.effectiveOn} />
      </div>
      {error && <NoticeRS.Notice error={error} />}
      <div className="on-form-actions">
        <button type="button" onClick={() => decide('approved')} disabled={Boolean(busy) || readOnly}>{busy === 'approved' ? '記録しています…' : '承認'}</button>
        <button type="button" className="secondary" onClick={() => decide('rejected')} disabled={Boolean(busy) || readOnly}>{busy === 'rejected' ? '記録しています…' : '却下'}</button>
      </div>
    </div>
  );
}

export function ReceiptSheet({data, request: requestProp, onNavigate}) {
  const shell = ShellRS.useShell();
  const request = requestProp || shell.request;
  const navigate = onNavigate || shell.navigate;
  const readOnly = Boolean(shell.readOnly || request?.readOnly);
  const isAdmin = data?.currentUser?.role === 'admin';
  const [fiscal] = FiscalRS.useFiscal(request);
  const today = ReceiptRS.todayJst();
  const fiscalStart = ConditionRS.fiscalYearRange(ConditionRS.fiscalYearOf(ConditionRS.currentYm(), fiscal.fiscalStartMonth), fiscal.fiscalStartMonth).from;
  const [local, setLocal] = ReactRS.useState({start: null, asOf: today});
  const urlStart = shell.getParam('start', null);
  const urlAsOf = shell.getParam('asOf', null);
  const start = ConditionRS.isYm(urlStart || '') ? urlStart : (local.start || fiscalStart);
  const asOf = RS_DATE.test(urlAsOf || '') ? urlAsOf : local.asOf;
  const ready = ConditionRS.isYm(urlStart || '') || Boolean(local.start) || fiscal.loaded;
  const setCondition = (key, value, valid) => {
    if (!valid(value || '')) return;
    setLocal((previous) => ({...previous, [key]: value}));
    shell.setParam(key, value, {replace: true});
  };

  const [state, setState] = ReactRS.useState({loading: true, body: null, error: null});
  const [detail, setDetail] = ReactRS.useState(null); // {invoiceId, mode: null | 'receipt' | 'change'}
  const [expand, setExpand] = ReactRS.useState(null);
  const [notice, setNotice] = ReactRS.useState(null); // {invoiceId?, tone, message}
  const [refreshKey, setRefreshKey] = ReactRS.useState(0);
  const seq = ReactRS.useRef(0);

  const load = ReactRS.useCallback(async () => {
    if (!ready) return;
    const id = ++seq.current;
    setState((previous) => ({...previous, loading: true, error: null}));
    try {
      const body = await request(`/receipt-sheet?start=${start}&asOf=${asOf}`);
      if (id === seq.current) setState({loading: false, body, error: null});
    } catch (error) {
      if (id === seq.current) setState((previous) => ({loading: false, body: previous.body, error}));
    }
  }, [request, start, asOf, ready]);
  ReactRS.useEffect(() => { load(); }, [load]);

  const body = state.body;
  const rows = ReactRS.useMemo(() => ReceiptRS.receiptSheetRows(body), [body]);
  const totalRows = ReactRS.useMemo(() => ReceiptRS.receiptSheetTotals(body), [body]);
  const pending = ReactRS.useMemo(() => ReceiptRS.pendingPlanRequests(body), [body]);
  const months = body?.months || [];
  const overdue = rows.filter((row) => row.state.overdueDays > 0 && row.balance > 0);
  const partial = rows.filter((row) => row.paid > 0 && row.balance > 0);

  function open(row, mode) {
    setDetail({invoiceId: row.invoiceId, mode});
    setNotice((previous) => (previous?.invoiceId === row.invoiceId ? null : previous));
    setExpand((previous) => ({key: row.key, nonce: (previous?.nonce || 0) + 1}));
  }
  function done(message, invoiceId = null) {
    setNotice({invoiceId, tone: 'ok', message});
    if (invoiceId) setDetail({invoiceId, mode: null});
    setRefreshKey((key) => key + 1);
    load();
  }

  const monthColumns = months.map((month, index) => ({
    key: `m${index}`, label: FormatRS.month(month), type: 'yen', total: 'none',
    exportValue: (row) => row[`m${index}`] || null,
    render: (row) => (row[`m${index}`] ? FormatRS.int(row[`m${index}`]) : ''),
  }));
  // 状態・残高・操作を左に寄せ、横に長い月の列を右に置く（まず見る列が横スクロールの先に隠れないように）
  const columns = [
    {key: 'invoiceNumber', label: '請求番号', type: 'code', sticky: true, width: 17},
    {key: 'partnerName', label: '取引先', type: 'text'},
    {key: 'stateLabel', label: '状態', type: 'text',
      render: (row) => <><RsStateChip state={row.state} />{row.pendingRequests > 0 && <small className="rs-sub">予定変更の承認待ち</small>}</>},
    {key: 'balance', label: '残高', type: 'yen', total: 'sum'},
    {key: 'plannedDate', label: '入金予定日', type: 'date',
      render: (row) => <>{FormatRS.dateJst(row.plannedDate)}{row.planChanged && <small className="rs-sub">予定変更の承認済み</small>}</>},
    {key: 'actions', label: '操作', type: 'text', sortable: false, searchable: false, export: false, value: () => '',
      render: (row) => (row.canReceive ? (
        <div className="bl-row-actions">
          <button type="button" className="secondary" onClick={() => open(row, 'receipt')} disabled={readOnly}>入金を登録</button>
          <button type="button" className="secondary" onClick={() => open(row, 'change')} disabled={readOnly}>予定変更を申請</button>
        </div>
      ) : null)},
    {key: 'amount', label: '請求額（税込）', type: 'yen', total: 'sum', totalValue: (row) => (row.isVoid ? 0 : row.amount)},
    {key: 'paid', label: '入金済', type: 'yen', total: 'sum'},
    {key: 'dueDate', label: '契約期日', type: 'date'},
    ...monthColumns,
  ];
  const totalColumns = [{key: 'label', label: '月別の合計', type: 'text', sticky: true}, ...months.map((month, index) => ({key: `m${index}`, label: FormatRS.month(month), type: 'yen', total: 'none'}))];
  const title = '月別入金表';
  const conditions = [['開始月', FormatRS.month(start)], ['残高の基準日', FormatRS.dateJst(asOf)]];
  const notes = ['月の列は入金日の月の実入金額。取消は取消日の月に負の額。入金のない月は空欄。', '入金予定日は承認済みの予定変更を反映した日。請求書の支払期日・売上の計上月は変えない。'];

  function renderDetail(row) {
    const mode = detail?.invoiceId === row.invoiceId ? detail.mode : null;
    const rowNotice = notice?.invoiceId === row.invoiceId ? notice : null;
    return (
      <ReceiptFormRS.GridDetailFrame>
        {rowNotice && <NoticeRS.Notice tone={rowNotice.tone} message={rowNotice.message} onDismiss={() => setNotice(null)} />}
        {mode === null && row.canReceive && (
          <div className="bl-actions">
            <button type="button" onClick={() => open(row, 'receipt')} disabled={readOnly}>入金を登録</button>
            <button type="button" className="secondary" onClick={() => open(row, 'change')} disabled={readOnly}>予定変更を申請</button>
          </div>
        )}
        {mode === 'receipt' && (
          <ReceiptFormRS.ReceiptForm key={`receipt-${row.invoiceId}`} request={request} invoiceId={row.invoiceId} refreshKey={refreshKey} heading={`${row.invoiceNumber}の入金を登録`}
            onRegistered={({message}) => done(message, row.invoiceId)} onCancel={() => setDetail({invoiceId: row.invoiceId, mode: null})} />
        )}
        {mode === 'change' && (
          <RsPlanChangeForm key={`change-${row.invoiceId}`} row={row} request={request} readOnly={readOnly} onDone={(message) => done(message, row.invoiceId)}
            onCancel={() => setDetail({invoiceId: row.invoiceId, mode: null})} />
        )}
        <div className="bl-table-wrap">
          <table className="bl-table">
            <caption>入金の履歴（{row.events.length}件）</caption>
            {row.events.length > 0 && <thead><tr><th scope="col">入金日</th><th scope="col">参照番号</th><th scope="col" className="num">この請求への入金額</th><th scope="col">状態</th></tr></thead>}
            <tbody>
              {!row.events.length && <tr><td colSpan={4} className="rp-muted">まだ入金はありません。</td></tr>}
              {row.events.map((event) => (
                <tr key={event.receipt_id}>
                  <td>{FormatRS.dateJst(event.received_on)}</td><td>{event.reference}</td><td className="num">{FormatRS.int(event.amount_yen)}</td>
                  <td>{event.reversed_on ? <><span className="bl-state is-info">取消済み</span> {FormatRS.dateJst(event.reversed_on)}</> : <span className="bl-state is-ok">有効</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {row.history.length > 0 && (
          <div className="bl-table-wrap">
            <table className="bl-table">
              <caption>入金予定の変更の履歴（{row.history.length}件）</caption>
              <thead><tr><th scope="col">変更前 → 変更後</th><th scope="col">申請の理由</th><th scope="col">状態</th><th scope="col">決定の理由</th></tr></thead>
              <tbody>
                {row.history.map((item) => (
                  <tr key={item.id}>
                    <td>{FormatRS.dateJst(item.previous_due_date)} → {FormatRS.dateJst(item.proposed_due_date)}</td>
                    <td>{item.reason}</td>
                    <td><RsStateChip state={ReceiptRS.planRequestState(item)} />{item.effective_on && <small className="rs-sub">適用日 {FormatRS.dateJst(item.effective_on)}</small>}</td>
                    <td>{item.decision_reason || (item.decision ? '' : isAdmin ? '下の「承認待ち」で承認・却下できます' : '管理者の承認待ち')}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </ReceiptFormRS.GridDetailFrame>
    );
  }

  const pageNotice = notice && !notice.invoiceId ? notice : null;
  return (
    <div className="stack receipt-sheet">
      <section className="card rp-report" aria-label={title}>
        <header className="rp-head">
          <div>
            <h2>{title}</h2>
            <p className="rp-muted">請求ごとの入金予定と、月ごとの実入金。期日を過ぎた未入金と一部入金は、状態の色と文字で示します。入金の登録は「請求・入金」と同じ手順で、複数の請求へ配分できます。</p>
          </div>
          {body && (
            <OutputRS.ReportOutputBar name={title} period={start} title={title} subtitle={`${FormatRS.month(start)}から12か月・残高の基準日 ${FormatRS.dateJst(asOf)}`} sheets={() => [
              GridModelRS.gridSheetSpec({columns, rows, exportSpec: {name: '月別入金表', title, conditions, notes}}),
              GridModelRS.gridSheetSpec({columns: totalColumns, rows: totalRows, showTotals: false, exportSpec: {name: '月別の合計', title: '月別の合計（実入金計・残額の入金予定）', conditions}}),
            ]} />
          )}
        </header>
        <section className="on-conditions" aria-label="条件">
          <FieldRS.FormField type="month" label="開始月" value={start} onChange={(value) => setCondition('start', value, ConditionRS.isYm)} hint="ここから12か月を表示します" />
          <FieldRS.FormField type="date" label="残高の基準日" value={asOf} onChange={(value) => setCondition('asOf', value, (text) => RS_DATE.test(text))} hint="この日までの入金で残高と状態を出します" />
        </section>
        <nav className="bl-links" aria-label="関連する画面">
          <span>関連:</span>
          <button type="button" className="secondary" onClick={() => navigate?.('請求・入金')}>請求・入金（作品ごと）</button>
          <button type="button" className="secondary" onClick={() => navigate?.('帳票センター', {report: 'receivables'})}>売掛金の一覧（帳票センター）</button>
          <button type="button" className="secondary" onClick={() => navigate?.('帳票センター', {report: 'partner-balance'})}>取引先別の売掛残高推移（帳票センター）</button>
        </nav>
        {body && (
          <div className="rp-tiles">
            <div><span>請求（{FormatRS.dateJst(asOf)}時点）</span><strong>{FormatRS.int(rows.length)}件</strong></div>
            <div><span>残高の合計</span><strong>{FormatRS.yen(rows.reduce((sum, row) => sum + row.balance, 0))}</strong></div>
            <div className={overdue.length ? 'is-warn' : undefined}><span>期日超過</span><strong>{FormatRS.int(overdue.length)}件</strong><small>{FormatRS.yen(overdue.reduce((sum, row) => sum + row.balance, 0))}</small></div>
            <div><span>一部入金</span><strong>{FormatRS.int(partial.length)}件</strong></div>
            <div className={pending.length ? 'is-warn' : undefined}><span>予定変更の承認待ち</span><strong>{FormatRS.int(pending.length)}件</strong></div>
          </div>
        )}
      </section>
      {pageNotice && <NoticeRS.Notice tone={pageNotice.tone} message={pageNotice.message} onDismiss={() => setNotice(null)} />}
      {state.error && <NoticeRS.Notice error={state.error} onRetry={load} />}
      {!body && state.loading && <section className="card"><p className="rp-muted" aria-busy="true">月別入金表を読み込んでいます…</p></section>}
      {body && (
        <>
          <section className="card" aria-label="請求ごとの月別入金">
            <GridRS.DataGrid columns={columns} rows={rows} rowKey="key" persistKey="receipt-sheet" renderDetail={renderDetail} expandRequest={expand} maxHeight="none" ariaLabel="請求ごとの月別入金"
              emptyText="基準日までに発行された請求はありません。「請求・入金」で売上報告から請求を作成すると、ここに並びます。"
              toolbar={<span className="rp-muted">行を押すと入金・予定変更の履歴を開きます</span>} />
          </section>
          <section className="card" aria-label="月別の合計">
            <header className="section-head"><div><h3>月別の合計</h3><p className="rp-muted">実入金計は入金日の月、残額の入金予定は入金予定日の月の残高です。</p></div></header>
            <GridRS.DataGrid columns={totalColumns} rows={totalRows} rowKey="key" showTotals={false} persistKey="receipt-sheet-totals" ariaLabel="月別の合計" />
          </section>
          <section className="card" aria-label="入金予定の変更の承認待ち">
            <header className="section-head"><div><h3>入金予定の変更の承認待ち（{FormatRS.int(pending.length)}件）</h3>
              <p className="rp-muted">承認すると入金予定日が変わり、期日超過はその日から数えます。{isAdmin ? '' : '承認・却下は管理者が行います。'}</p></div></header>
            {!pending.length && <p className="rp-muted">承認待ちの申請はありません。</p>}
            {pending.length > 0 && (
              <ul className="rs-requests">
                {pending.map((item) => (
                  <li key={item.id}>
                    <div className="rs-request-head">
                      <strong>{item.invoiceNumber}（{item.partnerName}）</strong>
                      <span>{FormatRS.dateJst(item.previousDueDate)} → {FormatRS.dateJst(item.proposedDueDate)}</span>
                      <RsStateChip state={ReceiptRS.planRequestState(null)} />
                    </div>
                    <p>申請の理由: {item.reason}</p>
                    {isAdmin && <RsPlanDecision item={item} request={request} readOnly={readOnly} onDone={(message) => done(message)} />}
                  </li>
                ))}
              </ul>
            )}
          </section>
        </>
      )}
    </div>
  );
}

// ---- 流通別の販売条件（営業作品一覧）----
// 会社全体の表（作品×流通×地域の最新版）。販売条件の登録・改訂の正面入口はこの画面1つ
// （番販・放送、作品・商品マスタからは navigate('営業作品一覧', {dist, territory, edit: '1'}, {workId}) で該当の行を開く）。
// - 状態の語彙は labels.mjs の availabilityStatus、販売期間の状況は別の列。地域は選択肢と名寄せで表記ゆれを防ぐ。
// - 新しい版は前の版の調達ケース・文書のリンクを引き継ぐ（broadcast-draft.mjs）。確認ダイアログは出さず、保存後に変わった項目を示す。
const SC_STATUS_TONE = {confirmed: 'ok', draft: 'warn', withdrawn: 'info'};
const scShown = (value) => (value === null || value === undefined || String(value).trim() === '' ? '未入力' : String(value));

function ScGroupedSelect({label, required, value, onChange, groups, error, hint, disabled}) {
  const id = `scg${ReactSC.useId().replace(/:/g, '')}`;
  const describedBy = [hint ? `${id}-hint` : null, error ? `${id}-error` : null].filter(Boolean).join(' ') || undefined;
  return (
    <div className={`on-field${error ? ' on-field-invalid' : ''}`}>
      <label className="on-field-label" htmlFor={id}><span>{label}</span>{required && <span className="on-req">必須</span>}</label>
      <select id={id} value={value || ''} disabled={disabled} aria-invalid={error ? true : undefined} aria-required={required || undefined} aria-describedby={describedBy}
        onChange={(event) => onChange(event.target.value)}>
        <option value="">選択してください</option>
        {groups.map((group) => (
          <optgroup key={group.label} label={group.label}>
            {group.options.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
          </optgroup>
        ))}
      </select>
      {hint && <p id={`${id}-hint`} className="on-field-hint">{hint}</p>}
      {error && <p id={`${id}-error`} className="on-field-error">{error}</p>}
    </div>
  );
}

function scChangeList(draft, result) {
  const intakeText = (id) => (id == null || id === '' ? '未紐付け' : (result.intakes || []).find((row) => Number(row.id) === Number(id))?.case_code || '参照できないケース');
  const documentText = (id) => (id == null || id === '' ? '未紐付け' : (result.documents || []).find((row) => Number(row.id) === Number(id))?.title || '参照できない文書');
  const display = (key, value) => {
    if (key === 'status') return CatalogSC.availabilityStatusLabel(value);
    if (key === 'exclusivity') return LabelsSC.labelOf('exclusivity', value);
    if (key === 'intakeCaseId') return intakeText(value);
    if (key === 'documentId') return documentText(value);
    if (key === 'releaseOn' || key === 'salesEndOn') return value ? FormatSC.dateJst(value) : '未入力';
    return scShown(value);
  };
  if (!draft?.original) return [];
  return DraftSC.CONDITION_FIELDS
    .filter(([key, column]) => String(draft[key] ?? '') !== String(draft.original[column] ?? ''))
    .map(([key, column, label]) => ({column: label, message: `${display(key, draft.original[column])} → ${display(key, draft[key])}`}));
}

function ScConditionEditor({mode, initialDraft, result, rows, request, readOnly, onSaved, onClose, onOpenExisting}) {
  const shell = ShellSC.useShell();
  const [draft, setDraft] = ReactSC.useState(initialDraft);
  const [territory, setTerritory] = ReactSC.useState(() => CatalogSC.territoryInput(initialDraft.territory));
  const [errors, setErrors] = ReactSC.useState({});
  const [error, setError] = ReactSC.useState(null);
  const [saving, setSaving] = ReactSC.useState(false);
  const unsavedId = `sce${ReactSC.useId().replace(/:/g, '')}`;
  const initialJson = ReactSC.useMemo(() => JSON.stringify({initialDraft: {...initialDraft, original: undefined}, territory: CatalogSC.territoryInput(initialDraft.territory)}), [initialDraft]);
  const dirty = JSON.stringify({initialDraft: {...draft, original: undefined}, territory}) !== initialJson;
  const register = shell.registerUnsaved;
  ReactSC.useEffect(() => { register?.(unsavedId, dirty ? 1 : 0, '販売条件の入力'); }, [dirty, unsavedId, register]);
  ReactSC.useEffect(() => () => register?.(unsavedId, 0, '販売条件の入力'), [unsavedId, register]); // eslint-disable-line react-hooks/exhaustive-deps

  const set = (key) => (value) => {
    setDraft((previous) => {
      const next = {...previous, [key]: value};
      if (key === 'workId') { next.workId = value ? Number(value) : ''; next.intakeCaseId = null; next.documentId = null; }
      if (key === 'intakeCaseId') { next.intakeCaseId = value ? Number(value) : null; next.documentId = null; }
      if (key === 'documentId') next.documentId = value ? Number(value) : null;
      return next;
    });
    setErrors((previous) => ({...previous, [key]: undefined}));
    setError(null);
  };
  const territoryText = mode === 'new' ? CatalogSC.territoryFromInput(territory.select, territory.other) : draft.territory;
  const existing = mode === 'new' && draft.workId && draft.distributionCode && territoryText
    ? rows.find((row) => row.kind === 'condition' && row.work_id === Number(draft.workId) && row.distribution_code === draft.distributionCode
      && CatalogSC.territoryKey(row.territory_raw) === CatalogSC.territoryKey(territoryText))
    : null;
  const changes = mode === 'version' ? scChangeList(draft, result) : [];
  const types = result.types || [];
  const workTitle = (result.works || []).find((work) => work.id === Number(draft.workId))?.title;

  async function submit(event) {
    event.preventDefault();
    if (saving || readOnly) return;
    const found = {};
    if (!draft.workId) found.workId = '作品を選んでください';
    if (!draft.distributionCode) found.distributionCode = '流通を選んでください';
    if (!territoryText) found.territory = '地域を選んでください';
    if (!String(draft.sourceReference || '').trim()) found.sourceReference = '契約根拠・参照箇所を入力してください';
    if (draft.status === 'confirmed') {
      if (!draft.releaseOn) found.releaseOn = '条件確認済みには解禁日が必要です';
      if (!draft.salesEndOn) found.salesEndOn = '条件確認済みには販売終了日が必要です';
      if (!String(draft.terms || '').trim()) found.terms = '条件確認済みには販売条件の基準が必要です';
    }
    if (draft.releaseOn && draft.salesEndOn && draft.salesEndOn < draft.releaseOn) found.salesEndOn = '販売終了日は解禁日以後にしてください';
    setErrors(found);
    if (Object.keys(found).length) { setError({tone: 'error', message: `${Object.keys(found).length}項目を確認してください`}); return; }
    if (existing) { setError({tone: 'warn', message: `この作品・流通・地域の販売条件はすでに第${existing.version_no}版まであります。一覧のその行から新しい版を作ってください。`}); return; }
    if (mode === 'version' && !changes.length) { setError({tone: 'warn', message: '前の版から変わった項目がありません。変える項目を入力してください。'}); return; }
    setSaving(true);
    setError(null);
    try {
      const saved = await request('/sales-catalog', {method: 'POST', body: JSON.stringify(DraftSC.conditionPayload({...draft, territory: territoryText}))});
      const where = `${workTitle || '作品'}・${CatalogSC.distributionDisplay(types.find((type) => type.code === draft.distributionCode))}・${CatalogSC.territoryLabel(saved.territory)}`;
      const merged = saved.territoryMatch === 'alias' ? `「${territoryText}」は登録済みの「${saved.territory}」と同じ地域として、その版に続けて保存しました。` : '';
      onSaved?.({tone: 'ok', message: `${where}の販売条件を第${saved.version}版として保存しました。${merged}`, details: changes});
    } catch (failure) {
      setError(failure);
    } finally {
      setSaving(false);
    }
  }

  return (
    <form className="so-form" onSubmit={submit} noValidate aria-label={mode === 'new' ? '販売条件の新規登録' : '販売条件の新しい版'}>
      <h4>{mode === 'new' ? '販売条件を登録（第1版）' : `新しい版を作る（第${draft.baseVersion}版 → 第${draft.baseVersion + 1}版）`}</h4>
      <fieldset className="on-form-grid" disabled={saving || readOnly}>
        {mode === 'new' ? (
          <>
            <FieldSC.FormField type="select" label="作品" required value={draft.workId ? String(draft.workId) : ''} onChange={set('workId')} error={errors.workId}
              options={(result.works || []).map((work) => ({value: String(work.id), label: work.title}))} />
            <ScGroupedSelect label="流通" required value={draft.distributionCode} onChange={set('distributionCode')} error={errors.distributionCode}
              groups={CatalogSC.distributionGroups(types, draft.distributionCode)} hint="流通区分マスタから選びます" />
            <FieldSC.FormField type="select" label="地域" required value={territory.select} error={errors.territory}
              onChange={(value) => { setTerritory((previous) => ({...previous, select: value})); setErrors((previous) => ({...previous, territory: undefined})); }}
              options={CatalogSC.territoryOptions()} hint="「国内」「Japan」などは「日本」にそろえて保存します" />
            {territory.select === CatalogSC.OTHER_TERRITORY && (
              <FieldSC.FormField label="地域（その他）" required value={territory.other} onChange={(value) => setTerritory((previous) => ({...previous, other: value}))}
                hint={territory.other ? `「${CatalogSC.territoryLabel(territory.other)}」として保存します` : undefined} />
            )}
          </>
        ) : (
          <p className="rp-muted on-field-wide">
            {workTitle || '作品'}・{CatalogSC.distributionDisplay(types.find((type) => type.code === draft.distributionCode))}・{CatalogSC.territoryLabel(draft.territory)}
            {CatalogSC.territoryLabel(draft.territory) !== draft.territory ? `（保存値: ${draft.territory}）` : ''}
          </p>
        )}
        <FieldSC.FormField type="date" label="解禁日" value={draft.releaseOn} onChange={set('releaseOn')} error={errors.releaseOn} />
        <FieldSC.FormField type="date" label="販売終了日" value={draft.salesEndOn} onChange={set('salesEndOn')} error={errors.salesEndOn} />
        <FieldSC.FormField type="select" label="状態" includeBlank={false} value={draft.status} onChange={set('status')} options={CatalogSC.availabilityStatusOptions()}
          hint="条件確認済みには解禁日・販売終了日・販売条件の基準が必要です" />
        <FieldSC.FormField type="select" label="独占" includeBlank={false} domain="exclusivity" value={draft.exclusivity} onChange={set('exclusivity')} />
        <FieldSC.FormField type="textarea" label="販売条件の基準" rows={3} value={draft.terms} onChange={set('terms')} error={errors.terms}
          placeholder="料率・MG・最低価格・許諾範囲など、契約で確認できた条件" />
        <FieldSC.FormField label="契約根拠・参照箇所" required wide value={draft.sourceReference} onChange={set('sourceReference')} error={errors.sourceReference} />
        <FieldSC.FormField type="select" label="調達ケース" blankLabel="未紐付け" value={draft.intakeCaseId == null ? '' : String(draft.intakeCaseId)} onChange={set('intakeCaseId')}
          options={(result.intakes || []).filter((row) => row.work_id === Number(draft.workId)).map((row) => ({value: String(row.id), label: row.title ? `${row.case_code}｜${row.title}` : row.case_code}))} />
        <FieldSC.FormField type="select" label="契約文書" blankLabel="参照文字列のみ" value={draft.documentId == null ? '' : String(draft.documentId)} onChange={set('documentId')}
          options={(result.documents || []).filter((row) => row.intake_case_id === Number(draft.intakeCaseId)).map((row) => ({value: String(row.id), label: row.title || row.reference}))} />
      </fieldset>
      {mode === 'version' && (
        <p className="rp-muted">{changes.length ? `前の版から変わる項目: ${changes.map((change) => change.column).join('・')}` : '前の版から変わった項目はまだありません。'}（{DraftSC.conditionLinkText(draft, result)}）</p>
      )}
      {existing && (
        <NoticeSC.Notice tone="warn" compact message={`この作品・流通・地域（${existing.territory}）の販売条件はすでに第${existing.version_no}版まであります。`}
          actions={<button type="button" className="secondary" onClick={() => onOpenExisting?.(existing)}>その行を開く</button>} />
      )}
      {error && (error instanceof Error ? <NoticeSC.Notice error={error} /> : <NoticeSC.Notice tone={error.tone} message={error.message} />)}
      <div className="on-form-actions">
        <button type="submit" disabled={saving || readOnly}>{saving ? '保存中…' : mode === 'new' ? '第1版として保存' : 'この内容で新しい版を保存'}</button>
        <button type="button" className="secondary" disabled={saving} onClick={onClose}>{LabelsSC.VERBS.close}</button>
      </div>
    </form>
  );
}

const SC_HISTORY_COLUMNS = [
  {key: 'version_no', label: '版', type: 'text', sticky: true, value: (row) => `第${row.version_no}版`},
  {key: 'status', label: '状態', type: 'text', value: (row) => CatalogSC.availabilityStatusLabel(row.status)},
  {key: 'release_on', label: '解禁日', type: 'date'},
  {key: 'sales_end_on', label: '販売終了日', type: 'date'},
  {key: 'exclusivity', label: '独占', type: 'status', domain: 'exclusivity'},
  {key: 'terms_text', label: '販売条件の基準', type: 'text', wrap: true},
  {key: 'source_reference', label: '契約根拠', type: 'text', wrap: true},
  {key: 'created_at', label: '登録日時', type: 'datetime'},
  {key: 'created_by_name', label: '登録者', type: 'text'},
];

function ScSeriesDetail({row, result, rows, request, readOnly, autoEdit, onSaved, onNew, onOpenExisting}) {
  const [history, setHistory] = ReactSC.useState({loading: true});
  const [editing, setEditing] = ReactSC.useState(Boolean(autoEdit));
  ReactSC.useEffect(() => {
    if (row.kind !== 'condition') return undefined;
    let live = true;
    request(`/sales-catalog/versions?workId=${row.work_id}&distributionCode=${encodeURIComponent(row.distribution_code)}&territory=${encodeURIComponent(row.territory_raw)}`)
      .then((body) => { if (live) setHistory({rows: body.rows || []}); })
      .catch((error) => { if (live) setHistory({error}); });
    return () => { live = false; };
  }, [row.kind, row.work_id, row.distribution_code, row.territory_raw, row.version_no, request]);

  if (row.kind === 'missing') {
    return (
      <div className="so-detail">
        <p className="rp-muted">この作品には流通別の販売条件がまだありません。</p>
        {!readOnly && <div className="so-actions"><button type="button" onClick={() => onNew?.(row.work_id)}>この作品の販売条件を登録する</button></div>}
      </div>
    );
  }
  return (
    <div className="so-detail">
      {row.territory_variants && (
        <NoticeSC.Notice tone="warn" compact title="地域の表記ゆれ"
          message={`同じ地域が「${row.territory_variants.join('」「')}」の表記で別々に登録され、版の系列が分かれています。表示は「${row.territory}」にそろえています。新しい版は開いた行の系列に続けて保存します。`} />
      )}
      {history.error && <NoticeSC.Notice error={history.error} />}
      {history.rows && (
        <GridSC.DataGrid columns={SC_HISTORY_COLUMNS} rows={history.rows} rowKey="id" showTotals={false} maxHeight="40vh" ariaLabel="販売条件の版の履歴" />
      )}
      {!readOnly && (editing ? (
        <ScConditionEditor mode="version" initialDraft={DraftSC.conditionDraftFromRow(row.work_id, row.row)} result={result} rows={rows} request={request} readOnly={readOnly}
          onClose={() => setEditing(false)} onOpenExisting={onOpenExisting}
          onSaved={(notice) => { setEditing(false); onSaved?.(notice); }} />
      ) : (
        <div className="so-actions"><button type="button" onClick={() => setEditing(true)}>{LabelsSC.VERBS.newVersion}（第{row.version_no}版から）</button></div>
      ))}
    </div>
  );
}

export function SalesCatalog({data, request: requestProp}) {
  const shell = ShellSC.useShell();
  const requestRef = ReactSC.useRef(null);
  requestRef.current = requestProp || shell.request;
  const request = ReactSC.useCallback((path, options) => requestRef.current(path, options), []);
  const readOnly = Boolean(shell.readOnly);
  const today = PipelineSC.todayJst();
  const asOf = shell.getParam('asOf', today) || today;
  const [state, setState] = ReactSC.useState({loading: true});
  const [revision, setRevision] = ReactSC.useState(0);
  const [creating, setCreating] = ReactSC.useState(null);
  const [notice, setNotice] = ReactSC.useState(null);
  const [expand, setExpand] = ReactSC.useState(undefined);

  ReactSC.useEffect(() => {
    let live = true;
    setState((previous) => ({...previous, loading: true, error: null}));
    request(`/sales-catalog?asOf=${encodeURIComponent(asOf)}`)
      .then((body) => { if (live) setState({body}); })
      .catch((error) => { if (live) setState({error}); });
    return () => { live = false; };
  }, [asOf, revision, request]);

  const result = state.body;
  const rows = ReactSC.useMemo(() => CatalogSC.catalogGridRows(result, asOf), [result, asOf]);

  // 他の画面からの入口: navigate('営業作品一覧', {dist, territory, edit: '1'}, {workId}) — 作品は外枠の対象作品（URL の work）
  const linkDist = shell.getParam('dist', null);
  const linkWork = linkDist ? (shell.workId ?? data?.selectedWorkId ?? null) : null;
  const linkTerritory = shell.getParam('territory', null);
  const linkEdit = shell.getParam('edit', null) === '1';
  const linked = ReactSC.useMemo(() => {
    if (!result || !linkWork || !linkDist) return null;
    return rows.find((row) => row.kind === 'condition' && row.work_id === Number(linkWork) && row.distribution_code === linkDist
      && (!linkTerritory || CatalogSC.territoryKey(row.territory_raw) === CatalogSC.territoryKey(linkTerritory))) || null;
  }, [result, rows, linkWork, linkDist, linkTerritory]);
  const handledLink = ReactSC.useRef('');
  ReactSC.useEffect(() => {
    if (!result || !linkWork || !linkDist) return;
    const signature = `${linkWork}|${linkDist}|${linkTerritory || ''}`;
    if (handledLink.current === signature) return; // 同じ入口の再読込では開き直さない
    handledLink.current = signature;
    if (linked) setExpand({key: linked.key, nonce: signature});
    else if (!readOnly && (result.works || []).some((work) => work.id === Number(linkWork))) setCreating(DraftSC.newConditionDraft(Number(linkWork), linkDist, linkTerritory || '日本'));
  }, [result, linked, linkWork, linkDist, linkTerritory, readOnly]);

  const openExisting = (row) => {
    setCreating(null);
    setExpand({key: row.key, nonce: `${row.key}:${Date.now()}`});
  };
  const startNew = (workId) => {
    setNotice(null);
    setCreating(DraftSC.newConditionDraft(workId || data?.selectedWorkId || result?.works?.[0]?.id || '', '', '日本'));
  };
  const saved = (message) => {
    setNotice(message);
    setCreating(null);
    setRevision((n) => n + 1);
  };

  const columns = [
    {key: 'work_title', label: '作品', type: 'text', sticky: true},
    {key: 'distribution', label: '流通', type: 'text', value: (row) => (row.kind === 'missing' ? '（未登録）' : row.distribution)},
    {key: 'distribution_code', label: '流通ID', type: 'code', hidden: true},
    {key: 'territory', label: '地域', type: 'text',
      render: (row) => (row.territory_variants ? <>{row.territory} <ToneSC.ToneLabel tone="warn">表記ゆれあり</ToneSC.ToneLabel></> : row.territory ?? '—')},
    {key: 'release_on', label: '解禁日', type: 'date'},
    {key: 'sales_end_on', label: '販売終了日', type: 'date'},
    {key: 'status_label', label: '状態', type: 'text',
      render: (row) => <ToneSC.ToneLabel tone={row.kind === 'missing' ? 'warn' : SC_STATUS_TONE[row.status] || 'info'}>{row.status_label}</ToneSC.ToneLabel>},
    {key: 'period', label: `販売期間（${FormatSC.dateJst(asOf)}時点）`, type: 'text',
      render: (row) => (row.period ? <ToneSC.ToneLabel tone={row.period_tone}>{row.period}</ToneSC.ToneLabel> : '—')},
    {key: 'overlaps', label: '販売契約との重なり', type: 'text', render: (row) => (row.overlaps ? <ToneSC.ToneLabel tone="warn">確認: {row.overlaps}</ToneSC.ToneLabel> : '—')},
    {key: 'exclusivity', label: '独占', type: 'text'},
    {key: 'terms_text', label: '販売条件の基準', type: 'text', wrap: true},
    {key: 'source_reference', label: '契約根拠', type: 'text', wrap: true},
    {key: 'intake', label: '調達ケース', type: 'code'},
    {key: 'version_no', label: '版', type: 'int', total: 'none'},
  ];
  const conditionRows = rows.filter((row) => row.kind === 'condition');
  const missingRows = rows.filter((row) => row.kind === 'missing');
  const conditionCount = conditionRows.length;
  const missingCount = missingRows.length;
  const variantCount = rows.filter((row) => row.territory_variants).length;

  return (
    <div className="so-page">
      <section className="card rp-report" aria-label="流通別の販売条件">
        <header className="so-head">
          <div>
            <h2>流通別の販売条件（全作品）</h2>
            <p className="rp-muted">販売条件の登録と新しい版はこの画面で行います（番販・放送、作品・商品マスタからはこの画面を開きます）。期間内でも、販売契約と重なる場合は確認が必要です。</p>
          </div>
          <div className="so-actions">
            <FieldSC.FormField type="date" label="確認日" value={asOf} onChange={(value) => shell.setParam('asOf', value && value !== today ? value : null, {replace: true})} />
            {!readOnly && <button type="button" onClick={() => startNew()} disabled={!result}>＋流通条件を追加</button>}
          </div>
        </header>
        {result && (
          <p className="rp-meta">
            <span>作品 {FormatSC.int(result.works?.length || 0)}件</span>
            <span>販売条件 {FormatSC.int(conditionCount)}件（各系列の最新版）</span>
            <span>条件が未登録の作品 {FormatSC.int(missingCount)}件</span>
            {variantCount > 0 && <span className="rp-warn">地域の表記ゆれ {FormatSC.int(variantCount)}件</span>}
          </p>
        )}
        {state.error && <NoticeSC.Notice error={state.error} onRetry={() => setRevision((n) => n + 1)} />}
        {notice && <NoticeSC.Notice tone={notice.tone} message={notice.message} details={notice.details?.length ? notice.details : undefined} onDismiss={() => setNotice(null)} />}
        {creating && result && (
          <ScConditionEditor key={`${creating.workId}:${creating.distributionCode}:${creating.territory}`} mode="new" initialDraft={creating} result={result} rows={rows}
            request={request} readOnly={readOnly} onClose={() => setCreating(null)} onSaved={saved} onOpenExisting={openExisting} />
        )}
      </section>
      {result && <ReleaseSC.ReleaseMonthView rows={conditionRows} asOf={asOf} onOpen={openExisting} />}
      {missingRows.length > 0 && (
        <section className="card so-section" aria-label="販売条件が未登録の作品">
          <h3>販売条件が未登録の作品（{FormatSC.int(missingRows.length)}件）</h3>
          <ul className="so-candidates">
            {missingRows.map((row) => (
              <li key={row.key}>
                <strong>{row.work_title}</strong>
                {!readOnly && <button type="button" className="secondary" onClick={() => startNew(row.work_id)}>この作品の販売条件を登録する</button>}
              </li>
            ))}
          </ul>
        </section>
      )}
      <section className="card so-section">
        {state.loading && !result && <p className="rp-muted" aria-busy="true">読み込み中…</p>}
        {result && (
          <GridSC.DataGrid columns={columns} rows={conditionRows} rowKey="key" persistKey="sales-catalog" expandRequest={expand}
            emptyText={result.works?.length ? '販売条件はまだありません。「＋流通条件を追加」から登録します。' : '閲覧できる作品がありません。'}
            exportSpec={{name: '流通別の販売条件', title: '流通別の販売条件（営業作品一覧）', dataAsOf: FormatSC.dateJst(today),
              conditions: [['確認日', FormatSC.dateJst(asOf)], ['対象', '営業（財務）の権限がある全作品・各系列の最新版']],
              notes: ['地域は表記をそろえて表示しています（保存値は行の詳細に表示）。', '状態は保存された版の状態、販売期間は確認日時点の状況です。',
                ...(missingRows.length ? [`販売条件が未登録の作品: ${missingRows.map((row) => row.work_title).join('、')}`] : [])]}}
            renderDetail={(row) => (
              <ScSeriesDetail row={row} result={result} rows={rows} request={request} readOnly={readOnly}
                autoEdit={linkEdit && linked?.key === row.key} onSaved={saved} onNew={startNew} onOpenExisting={openExisting} />
            )} />
        )}
      </section>
    </div>
  );
}

// ---- 流通マスタ（DistributionMaster）----
// 受領した流通ID・流通名・取引方法・販売種別・備考の一覧。読み取り専用の表で、Excel・CSV・印刷に出せる。
const DM_COLUMNS = [
  {key: 'code', label: '流通ID', type: 'code', sticky: true},
  {key: 'distribution_name', label: '流通名', type: 'text'},
  {key: 'transaction_method', label: '取引方法', type: 'text'},
  {key: 'sales_type', label: '販売種別', type: 'text'},
  {key: 'notes', label: '備考', type: 'text', wrap: true},
];
export function DistributionMaster({request: requestProp}) {
  const shell = ShellRS.useShell();
  const request = requestProp || shell.request;
  const [state, setState] = ReactRS.useState({loading: true});
  const load = ReactRS.useCallback(() => {
    let live = true;
    setState((previous) => ({...previous, loading: true, error: null}));
    request('/distribution-master').then((body) => live && setState({loading: false, body})).catch((error) => live && setState({loading: false, error}));
    return () => { live = false; };
  }, [request]);
  ReactRS.useEffect(() => load(), [load]);
  const rows = state.body?.rows || [];
  const title = '流通区分マスタ';
  return (
    <section className="card rp-report" aria-label={title}>
      <header className="rp-head">
        <div>
          <h2>{title}</h2>
          <p className="rp-muted">受領した流通ID・流通名・取引方法・販売種別・備考です。売上の分類の選択肢はこの一覧から出します。以前の分類で登録した売上の履歴はそのまま残します。</p>
        </div>
      </header>
      <NoticeRS.Notice tone="info" compact message="返品の符号、消化納品、相殺、委員会収入、調整の集計ルールは確認中です。分類を変えても、金額・計上月は自動では変わりません。" />
      {state.error && <NoticeRS.Notice error={state.error} onRetry={load} />}
      {state.loading && !state.body && <p className="rp-muted" aria-busy="true">流通区分マスタを読み込んでいます…</p>}
      {state.body && (
        <>
          <div className="rp-meta"><span>{FormatRS.int(rows.length)}件</span>{state.body.source && <span>出所: {state.body.source}</span>}</div>
          <GridRS.DataGrid columns={DM_COLUMNS} rows={rows} rowKey="code" persistKey="distribution-master" showTotals={false} ariaLabel={title}
            emptyText="流通区分マスタはまだ読み込まれていません。"
            exportSpec={{name: title, title, conditions: state.body.source ? [['出所', state.body.source]] : [], notes: ['返品の符号・消化納品・相殺・委員会収入・調整の集計ルールは確認中。']}} />
        </>
      )}
    </section>
  );
}
