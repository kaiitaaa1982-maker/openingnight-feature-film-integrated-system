// 入金の登録（1つの部品）。「請求・入金」と「月別入金表」の両方がこれを使うので、同じ入力なら同じ登録になる。
// - 消込先は、財務権限のある全作品の未消込の請求（/api/receipt-sheet を「いまの未消込」の基準日で読む）。
// - 複数請求へ配分できる。既定の消込額は min(入金の未充当, 請求の未消込)。手で直した額は保つ。
// - 同じ取引先・入金日・金額・参照番号の入金が登録済みなら警告し、理由を書かない限り先へ進ませない。
// - 入金は取り消せない登録なので、画面の中で2段で確かめる（「この内容で登録する」／「戻って直す」）。
//   登録の直前に最新の請求・入金を読み直し、内容が変わっていたら入力へ戻す。
// 論理は receipt-model.mjs（node で試験）。この部品は状態と描画だけを持つ。
import React, {useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState} from 'react';
import {useShell} from '../shell/context.mjs';
import {FormField} from '../ui/FormField.jsx';
import {Notice} from '../ui/Notice.jsx';
import {yen, int, dateJst} from '../ui/format.mjs';
import {
  OPEN_BALANCE_AS_OF, todayJst, receiptCandidates, partnerOptions, existingReceipts, initialReceiptState, setReceiptField,
  toggleInvoice, setAllocationText, autoAllocate, validateReceipt, receiptDirty, parseAmount,
} from './receipt-model.mjs';
import '../tax.css';

// 表（DataGrid）の行の直下に開く詳細の枠。表が横に長くても、見えている幅に収めて左に留める
// （右端のボタンが横スクロールの先に隠れないように）。
export function GridDetailFrame({className = 'bl-detail', children}) {
  const ref = useRef(null);
  const [width, setWidth] = useState(null);
  useLayoutEffect(() => {
    const scroller = ref.current?.closest?.('.dg-scroll');
    if (!scroller) return undefined;
    const measure = () => setWidth(Math.max(260, scroller.clientWidth - 32));
    measure();
    if (typeof ResizeObserver === 'undefined') return undefined;
    const observer = new ResizeObserver(measure);
    observer.observe(scroller);
    return () => observer.disconnect();
  }, []);
  return <div ref={ref} className={`${className} bl-detail-frame`} style={width ? {width} : undefined}>{children}</div>;
}

function countErrors(errors) {
  let count = 0;
  for (const [key, value] of Object.entries(errors || {})) count += key === 'lines' ? Object.keys(value).length : 1;
  return count;
}

function sameJson(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

export function ReceiptForm({request: requestProp, invoiceId = null, partnerId = null, refreshKey = 0, onRegistered, onCancel, heading = '入金を登録'}) {
  const shell = useShell();
  const request = requestProp || shell.request;
  const readOnly = Boolean(shell.readOnly || request?.readOnly);
  const [data, setData] = useState({loading: true, rows: null, error: null});
  const [form, setForm] = useState(null);
  const initialRef = useRef(null);
  const [step, setStep] = useState('input');
  const [showErrors, setShowErrors] = useState(false);
  const [notice, setNotice] = useState(null);
  const [busy, setBusy] = useState(false);
  const headingId = `rf${useId().replace(/:/g, '')}`;
  const unsavedId = `${headingId}-unsaved`;

  const loadRows = useCallback(async () => {
    const body = await request(`/receipt-sheet?start=${todayJst().slice(0, 7)}&asOf=${OPEN_BALANCE_AS_OF}`);
    return Array.isArray(body?.rows) ? body.rows : [];
  }, [request]);

  const reload = useCallback(() => {
    let live = true;
    setData((previous) => ({...previous, loading: true, error: null}));
    loadRows()
      .then((rows) => {
        if (!live) return;
        setData({loading: false, rows, error: null});
        setForm((previous) => {
          if (previous) return previous;
          const initial = initialReceiptState({partnerId, invoiceId, rows});
          initialRef.current = initial;
          return initial;
        });
      })
      .catch((error) => { if (live) setData({loading: false, rows: null, error}); });
    return () => { live = false; };
  }, [loadRows, partnerId, invoiceId]);

  useEffect(() => reload(), [reload, refreshKey]);

  // 入力中は外枠の「未保存の変更」に数える（画面移動の前に確かめる）
  const dirty = Boolean(form && initialRef.current && receiptDirty(form, initialRef.current));
  const register = shell.registerUnsaved;
  useEffect(() => { register?.(unsavedId, dirty ? 1 : 0, '入金の登録'); }, [dirty, unsavedId, register]);
  useEffect(() => () => register?.(unsavedId, 0, '入金の登録'), [unsavedId, register]); // eslint-disable-line react-hooks/exhaustive-deps

  const rows = data.rows || [];
  const candidatesOf = useCallback((state) => (state?.partnerId ? receiptCandidates(rows, {partnerId: state.partnerId, receivedOn: state.receivedOn}) : []), [rows]);
  const candidates = useMemo(() => candidatesOf(form), [candidatesOf, form]);
  const receipts = useMemo(() => existingReceipts(rows), [rows]);
  const options = useMemo(() => partnerOptions(rows), [rows]);
  const check = useMemo(() => (form ? validateReceipt(form, candidates, receipts) : null), [form, candidates, receipts]);
  const partnerName = options.find((option) => option.value === form?.partnerId)?.name
    || candidates[0]?.partnerName || rows.find((row) => String(row.partner_id) === form?.partnerId)?.partner_name || '取引先';

  function update(change) {
    setForm((previous) => change(previous));
    if (notice?.tone === 'error' || notice?.tone === 'warn') setNotice(null);
  }
  const setField = (key) => (value) => update((previous) => {
    const next = {...previous, [key]: value};
    return setReceiptField(previous, key, value, candidatesOf(next));
  });
  const toggle = (id, selected) => update((previous) => toggleInvoice(previous, candidatesOf(previous), id, selected));
  const setLine = (id) => (text) => update((previous) => setAllocationText(previous, candidatesOf(previous), id, text));
  const spread = () => update((previous) => autoAllocate(previous, candidatesOf(previous)));

  function review() {
    if (!check) return;
    setShowErrors(true);
    if (!check.ok) {
      setNotice({tone: 'error', message: `${countErrors(check.errors)}か所を確認してください。理由は各項目の下に出しています。`});
      return;
    }
    setNotice(null);
    setStep('confirm');
  }

  async function submit() {
    if (busy || readOnly || !check?.ok) return;
    setBusy(true);
    setNotice(null);
    try {
      // 登録の直前に最新を読み直す（ほかの人が同じ入金を登録した・請求が取り消された等）
      const fresh = await loadRows();
      setData({loading: false, rows: fresh, error: null});
      const freshCandidates = receiptCandidates(fresh, {partnerId: form.partnerId, receivedOn: form.receivedOn});
      const again = validateReceipt(form, freshCandidates, existingReceipts(fresh));
      if (!again.ok || !sameJson(again.payload, check.payload)) {
        setStep('input');
        setShowErrors(true);
        setNotice({tone: 'warn', message: '登録の直前に最新の請求・入金を確かめたところ、内容が変わっていました（ほかの人の登録や請求の取消など）。表示を確かめてから、もう一度「内容を確認」を押してください。'});
        return;
      }
      const payload = again.payload;
      const result = await request('/billing/receipts', {method: 'POST', body: JSON.stringify(payload)});
      const message = `${partnerName}からの入金 ${yen(payload.amountYen)}（入金日 ${dateJst(payload.receivedOn)}・参照番号 ${payload.reference}）を登録し、${payload.allocations.length}件の請求に消し込みました。`;
      let after = fresh;
      try { after = await loadRows(); } catch { /* 登録は済んでいる。一覧の読み直しに失敗しても結果は伝える */ }
      const next = initialReceiptState({rows: after, receivedOn: form.receivedOn});
      initialRef.current = next;
      setData({loading: false, rows: after, error: null});
      setForm(next);
      setStep('input');
      setShowErrors(false);
      setNotice({tone: 'ok', message});
      onRegistered?.({receiptId: result?.receiptId, message, payload});
    } catch (error) {
      setNotice({tone: 'error', error, message: undefined});
    } finally {
      setBusy(false);
    }
  }

  const summary = check?.summary;
  const errors = showErrors ? check?.errors || {} : {};
  const lineErrors = check?.errors?.lines || {};
  const duplicate = check?.duplicate || {duplicates: [], reversed: []};

  return (
    <section className="bl-receipt" aria-labelledby={headingId}>
      <header className="bl-receipt-head">
        <h3 id={headingId}>{heading}</h3>
        {onCancel && <button type="button" className="secondary" onClick={onCancel} disabled={busy}>閉じる</button>}
      </header>
      {data.error && <Notice error={data.error} onRetry={reload} />}
      {notice && <Notice tone={notice.tone} message={notice.message} error={notice.error} onDismiss={notice.tone === 'ok' ? () => setNotice(null) : undefined} />}
      {data.loading && !data.rows && <p className="rp-muted" aria-busy="true">未消込の請求を読み込んでいます…</p>}
      {form && data.rows && step === 'input' && (
        <>
          {!options.length && !form.partnerId && <p className="empty">未消込の請求はありません。請求を作成すると、ここで入金を登録できます。</p>}
          {(options.length > 0 || form.partnerId) && (
            <>
              <fieldset className="on-form-grid" disabled={busy}>
                <FormField type="select" label="取引先" required value={form.partnerId} options={options} onChange={setField('partnerId')} error={errors.partnerId}
                  hint="未消込の請求がある取引先（財務権限のある全作品）" />
                <FormField type="date" label="入金日" required value={form.receivedOn} onChange={setField('receivedOn')} error={errors.receivedOn} />
                <FormField type="yen" label="入金額" required value={form.amountText} onChange={setField('amountText')} error={errors.amount} />
                <FormField label="参照番号" required maxLength={160} value={form.reference} onChange={setField('reference')} error={errors.reference}
                  hint="通帳・入金明細の番号。二重登録の確認に使います" />
                <FormField type="textarea" label="注記" rows={2} value={form.note} onChange={setField('note')} hint="振込名義・手数料の差額など" />
              </fieldset>
              <fieldset className="bl-alloc" disabled={busy}>
                <legend>消し込む請求（入金予定日の古い順）</legend>
                <div className="bl-alloc-tools">
                  <button type="button" className="secondary" onClick={spread} disabled={!form.partnerId || !(parseAmount(form.amountText) > 0)}>入金予定日の古い順に配分</button>
                  <span className="rp-muted">選んだ請求の消込額は、入金の未充当と請求の未消込の小さい方が入ります。直した額はそのまま残ります。</span>
                </div>
                {!form.partnerId && <p className="rp-muted">取引先を選ぶと、未消込の請求が出ます。</p>}
                {form.partnerId && !candidates.length && <p className="empty">この取引先に未消込の請求はありません。</p>}
                {candidates.length > 0 && (
                  <ul className="bl-alloc-list">
                    {candidates.map((invoice) => {
                      const line = form.lines[invoice.invoiceId];
                      const selected = Boolean(line?.selected);
                      const current = summary?.lines.find((item) => item.invoiceId === invoice.invoiceId);
                      const lineError = (showErrors || line?.touched) ? lineErrors[invoice.invoiceId] : undefined;
                      return (
                        <li key={invoice.invoiceId} className={`bl-alloc-item${selected ? ' is-selected' : ''}${invoice.eligible ? '' : ' is-disabled'}`}>
                          <label className="bl-alloc-pick">
                            <input type="checkbox" checked={selected} disabled={!invoice.eligible && !selected} onChange={(event) => toggle(invoice.invoiceId, event.target.checked)} />
                            <span>
                              <strong>{invoice.invoiceNumber}</strong>
                              <small>請求日 {dateJst(invoice.invoiceDate)}・入金予定日 {dateJst(invoice.plannedDate)}</small>
                            </span>
                          </label>
                          <dl className="bl-alloc-nums">
                            <div><dt>請求額</dt><dd className="num">{int(invoice.amount)}</dd></div>
                            <div><dt>消込済</dt><dd className="num">{int(invoice.allocated)}</dd></div>
                            <div><dt>未消込</dt><dd className="num">{int(invoice.open)}</dd></div>
                          </dl>
                          {selected && (
                            <FormField type="yen" label={`${invoice.invoiceNumber}の消込額`} className="bl-alloc-amount" value={line.text} onChange={setLine(invoice.invoiceId)}
                              error={lineError} hint={current && current.amount !== null ? `消込後の未消込 ${yen(Math.max(0, current.after))}` : undefined} />
                          )}
                          {!invoice.eligible && <p className="on-field-hint bl-alloc-reason">{invoice.reason}</p>}
                        </li>
                      );
                    })}
                  </ul>
                )}
                {errors.allocations && <p className="on-field-error">{errors.allocations}</p>}
              </fieldset>
              {summary && (
                <div className="bl-receipt-sum" aria-live="polite">
                  <div><span>入金額</span><strong className="num">{summary.amount === null ? '未入力' : yen(summary.amount)}</strong></div>
                  <div><span>消込額の合計</span><strong className="num">{yen(summary.allocated)}</strong></div>
                  <div className={summary.unallocated === 0 ? 'is-ok' : summary.unallocated === null ? '' : 'is-warn'}>
                    <span>未充当</span>
                    <strong className="num">{summary.unallocated === null ? '—' : yen(summary.unallocated)}</strong>
                    <small>{summary.unallocated === 0 ? '入金額と一致' : summary.unallocated === null ? '入金額を入力してください' : summary.unallocated > 0 ? '消込額が足りません' : '消込額が入金額を超えています'}</small>
                  </div>
                </div>
              )}
              {duplicate.duplicates.length > 0 && (
                <>
                  <Notice tone="warn" title="同じ入金が登録済みです"
                    message="取引先・入金日・金額・参照番号が同じ入金があります。同じ振込を二重に登録していないか、通帳で確かめてください。">
                    <ul className="bl-dup-list">
                      {duplicate.duplicates.map((receipt) => (
                        <li key={receipt.receiptId}>入金日 {dateJst(receipt.receivedOn)}・参照番号 {receipt.reference}・{yen(receipt.amount)}（{receipt.invoiceNumbers.join('、') || '消込先未確認'}）</li>
                      ))}
                    </ul>
                  </Notice>
                  <FormField type="textarea" label="別の入金として登録する理由" required rows={2} value={form.duplicateReason} onChange={setField('duplicateReason')}
                    error={errors.duplicateReason} hint="理由は入金の注記に残ります。二重登録なら、登録せずに閉じてください" />
                </>
              )}
              {!duplicate.duplicates.length && duplicate.reversed.length > 0 && (
                <Notice tone="info" compact message={`同じ取引先・入金日・金額・参照番号の入金が過去に登録され、取り消されています（${duplicate.reversed.length}件）。そのまま登録できます。`} />
              )}
              <div className="on-form-actions">
                <button type="button" onClick={review} disabled={busy || readOnly}>内容を確認</button>
                {onCancel && <button type="button" className="secondary" onClick={onCancel} disabled={busy}>閉じる</button>}
                {readOnly && <span className="rp-muted">確認専用の表示では登録できません。</span>}
              </div>
            </>
          )}
        </>
      )}
      {form && step === 'confirm' && check?.payload && (
        <div className="bl-confirm">
          <Notice tone="warn" title="この内容で入金を登録します"
            message="登録した入金は削除できません。誤りに気づいたときは「入金の取消」で打ち消します（取消の記録が残ります）。" />
          <dl className="bl-confirm-meta">
            <div><dt>取引先</dt><dd>{partnerName}</dd></div>
            <div><dt>入金日</dt><dd>{dateJst(check.payload.receivedOn)}</dd></div>
            <div><dt>入金額</dt><dd className="num">{yen(check.payload.amountYen)}</dd></div>
            <div><dt>参照番号</dt><dd>{check.payload.reference}</dd></div>
            {check.payload.note && <div className="is-wide"><dt>注記</dt><dd className="bl-pre">{check.payload.note}</dd></div>}
          </dl>
          <div className="bl-table-wrap">
            <table className="bl-table">
              <caption>消し込む請求（{check.payload.allocations.length}件）</caption>
              <thead><tr><th scope="col">請求番号</th><th scope="col" className="num">未消込</th><th scope="col" className="num">消込額</th><th scope="col" className="num">消込後の未消込</th></tr></thead>
              <tbody>
                {summary.lines.filter((line) => line.amount > 0).map((line) => (
                  <tr key={line.invoiceId}><th scope="row">{line.invoiceNumber}</th><td className="num">{int(line.open)}</td><td className="num">{int(line.amount)}</td><td className="num">{int(line.after)}</td></tr>
                ))}
              </tbody>
              <tfoot><tr><th scope="row">合計</th><td /><td className="num">{int(summary.allocated)}</td><td /></tr></tfoot>
            </table>
          </div>
          <div className="on-form-actions">
            <button type="button" onClick={submit} disabled={busy || readOnly}>{busy ? '登録しています…' : 'この内容で登録する'}</button>
            <button type="button" className="secondary" onClick={() => { setStep('input'); setNotice(null); }} disabled={busy}>戻って直す</button>
          </div>
        </div>
      )}
    </section>
  );
}

export default ReceiptForm;
