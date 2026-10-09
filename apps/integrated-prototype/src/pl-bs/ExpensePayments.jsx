// 経費の出金日（経費の画面）と、製作委員会への出資の払込日（PL・BS の作品別の残高）。
// どちらも追加だけで、直すときは取消の行（取消日・理由）を足す。未払の経費・未払込の出資がすぐ分かるよう、残りの額を並べる。
import {ExpenseSheet} from '../expense-sheet/ExpenseSheet.jsx';
import React, {useEffect, useMemo, useState} from 'react';
import {useShell} from '../shell/context.mjs';
import {DataGrid} from '../ui/DataGrid.jsx';
import {Notice} from '../ui/Notice.jsx';
import {FormField} from '../ui/FormField.jsx';
import {parseYen} from '../ui/parse-input.mjs';
import {yen} from '../ui/format.mjs';
import {PAYMENT_METHODS} from '../reports/pl-bs-model.mjs';
import {runAction, reversalDateError} from './payment-actions.mjs';

const METHOD_OPTIONS = Object.entries(PAYMENT_METHODS).map(([value, label]) => ({value, label}));
const today = () => new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10);

export const EXPENSE_PAYMENT_COLUMNS = Object.freeze([
  {key: 'accountingMonth', label: '計上月', type: 'month', sticky: true},
  {key: 'category', label: '費目', type: 'text'},
  {key: 'description', label: '内容', type: 'text', wrap: true},
  {key: 'work', label: '作品', type: 'text', value: (row) => (row.workCode ? `${row.workCode}｜${row.workTitle}` : '（作品未定・案件の経費）')},
  {key: 'incTax', label: '税込額', type: 'yen'},
  {key: 'paidYen', label: '出金済み', type: 'yen'},
  {key: 'unpaidYen', label: '未払', type: 'yen'},
  {key: 'lastPaidOn', label: '最後の出金日', type: 'date'},
  {key: 'state', label: '状況', type: 'text'},
]);

function PaymentHistory({payments = [], onReverse}) {
  if (!payments.length) return <p className="rp-muted">出金の記録はまだありません。</p>;
  return (
    <ul className="plbs-payments">
      {payments.map((payment) => (
        <li key={payment.id}>
          {payment.paidOn}・{yen(payment.amountYen)}・{payment.methodLabel}{payment.note ? `・${payment.note}` : ''}
          {payment.reversesId ? <span className="rp-muted">（取消の行）</span> : payment.reversed ? <span className="rp-muted">（取り消し済み）</span>
            : onReverse && <button type="button" className="text" onClick={() => onReverse(payment)}>取り消す</button>}
        </li>
      ))}
    </ul>
  );
}

// 経費の画面: 選んだ作品（と、その案件の作品未定の経費）の出金の記録と未払
export function ExpensePaymentsPanel({work,onChanged}) {
 const shell=useShell(),[summary,setSummary]=useState(null),[revision,setRevision]=useState(0);
 useEffect(()=>{let live=true;shell.request(`/expense-payments${work?.id?'?workId='+work.id:''}`).then(r=>{if(live)setSummary(r.summary);}).catch(()=>{if(live)setSummary(null);});return()=>{live=false;};},[shell,work?.id,revision]);
 return <section aria-label="経費の出金"><h3>経費の出金</h3>{summary&&<p>未払の経費 {summary.unpaidCount}件／{yen(summary.unpaidYen)}</p>}<ExpenseSheet work={work} embedded onChanged={()=>{setRevision(n=>n+1);onChanged?.();}}/></section>;
}

const INVESTMENT_COLUMNS = Object.freeze([
  {key: 'contract', label: '委員会契約', type: 'text', sticky: true, value: (row) => `${row.contractCode}（条件版${row.versionNo}${row.latest ? '・最新' : ''}）`},
  {key: 'partner', label: '出資者', type: 'text', value: (row) => `${row.partnerName}${row.isSelf ? '（自社）' : ''}`},
  {key: 'amountYen', label: '出資額', type: 'yen'},
  // 払込は委員会契約×参加者で全部の条件版をまとめて、最新の条件版の行に出す（古い版の行は履歴で「—」）
  {key: 'paidYen', label: '払込済み（全部の条件版）', type: 'yen', value: (row) => (row.latest ? row.paidYen : null)},
  {key: 'unpaidYen', label: '未払込（最新の出資額−払込）', type: 'yen', value: (row) => (row.latest ? row.unpaidYen : null)},
]);

// 作品別の残高: 委員会作品の出資額と払込の記録
export function InvestmentPayments({workId, title, onChanged}) {
  const shell = useShell();
  const [state, setState] = useState({});
  const [reload, setReload] = useState(0);
  const [selected, setSelected] = useState(null);
  const [form, setForm] = useState({paidOn: today(), amount: '', method: 'transfer', note: ''});
  const [reverse, setReverse] = useState(null);
  const [notice, setNotice] = useState(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let live = true;
    shell.request(`/committee-investments?workId=${workId}`).then((body) => live && setState({body})).catch((error) => live && setState({error}));
    return () => { live = false; };
  }, [shell, workId, reload]);
  const rows = state.body?.rows || [];
  const key = (row) => `${row.termVersionId}:${row.partnerId}`;
  const current = rows.find((row) => key(row) === selected) || null;
  const run = (fn, message) => runAction(fn, {
    onStart: () => { setBusy(true); setNotice(null); },
    onOk: () => { setNotice({tone: 'ok', message}); setReload((n) => n + 1); onChanged?.(); },
    onError: (error) => { setNotice({tone: 'error', error}); if (error?.kind === 'conflict' || error?.status === 409) setReload((n) => n + 1); },
    onFinally: () => setBusy(false),
  });
  return (
    <section className="plbs-detail" aria-label="出資の払込">
      <h3>{title} の出資と払込</h3>
      {state.error && <Notice error={state.error} />}
      {notice && <Notice tone={notice.tone} message={notice.message} error={notice.error} onDismiss={() => setNotice(null)} />}
      <DataGrid columns={INVESTMENT_COLUMNS} rows={rows} rowKey={key} showTotals={false} ariaLabel="出資と払込" onRowClick={(row) => setSelected(key(row) === selected ? null : key(row))}
        emptyText="この作品の委員会に出資額の登録がありません" exportSpec={{name: '出資と払込'}} />
      {current && (
        <>
          {!current.latest && <p className="rp-muted">古い条件版（版{current.versionNo}）の行です。払込の記録と未払込は、最新の条件版の行に全部の版をまとめて出します。</p>}
          {current.latest && <PaymentHistory payments={current.payments} onReverse={shell.readOnly ? null : (payment) => setReverse({...payment, reversedOn: payment.paidOn, reason: ''})} />}
          {current.latest && current.unpaidYen > 0 && !shell.readOnly && (
            <form className="plbs-form" onSubmit={async (event) => {
              event.preventDefault();
              const amount = parseYen(form.amount, {allowNegative: false});
              if (!amount.ok || !amount.value) { setNotice({tone: 'error', message: '払込額を1円以上で入れてください'}); return; }
              if (await run(() => shell.request('/committee-investment-payments', {method: 'POST', body: JSON.stringify({termVersionId: current.termVersionId, partnerId: current.partnerId, paidOn: form.paidOn,
                amountYen: amount.value, method: form.method, note: form.note})}), `${current.partnerName} の払込 ${yen(amount.value)} を記録しました`)) setForm((f) => ({...f, amount: '', note: ''}));
            }}>
              <FormField type="date" label="払込日" required value={form.paidOn} onChange={(value) => setForm({...form, paidOn: value})} />
              <FormField type="yen" label="払込額（円）" required value={form.amount} onChange={(value) => setForm({...form, amount: value})} hint={`未払込 ${yen(current.unpaidYen)}`} />
              <FormField type="select" label="方法" includeBlank={false} value={form.method} options={METHOD_OPTIONS} onChange={(value) => setForm({...form, method: value})} />
              <FormField type="text" label="備考" value={form.note} maxLength={500} onChange={(value) => setForm({...form, note: value})} />
              <button type="submit" disabled={busy || !form.paidOn || !form.amount}>払込を記録</button>
            </form>
          )}
        </>
      )}
      {reverse && (
        <form className="plbs-form" onSubmit={async (event) => {
          event.preventDefault();
          const dateError = reversalDateError(reverse, '払込日');
          if (dateError) { setNotice({tone: 'error', message: dateError}); return; }
          if (await run(() => shell.request(`/committee-investment-payments/${reverse.id}/reverse`, {method: 'POST', body: JSON.stringify({reversedOn: reverse.reversedOn, reason: reverse.reason})}),
            `${reverse.paidOn} の払込 ${yen(reverse.amountYen)} を取り消しました`)) setReverse(null);
        }}>
          <FormField type="date" label="取消日" required value={reverse.reversedOn} onChange={(value) => setReverse({...reverse, reversedOn: value})} />
          <FormField type="text" label="取り消す理由" required wide value={reverse.reason} maxLength={500} onChange={(value) => setReverse({...reverse, reason: value})} />
          <button type="submit" disabled={busy || !reverse.reason.trim()}>取消の行を足す</button>
          <button type="button" className="secondary" onClick={() => setReverse(null)}>やめる</button>
        </form>
      )}
    </section>
  );
}
