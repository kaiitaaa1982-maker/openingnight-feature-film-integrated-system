// 入出金の履歴の画面（会社ルートの plans/2026-10-22-folder-cashflow.md の「最優先」）。
// 上: 口座ごとの「履歴の残高／銀行の残高／差」。下: 選んだ口座の履歴（日付・項目・入金・出金・残高の累計）。
// 操作は「口座を足す」「明細を取り込む（下見してから）」「項目を付ける」「明細の無い入出金を足す」。値は受け口から読むだけ
import React, {useCallback, useEffect, useState} from 'react';
import {Notice} from '../../ui/Notice.jsx';
import './cashbook.css';

const yen = (value) => (value == null ? '' : Number(value).toLocaleString('ja-JP'));
const today = () => new Date().toISOString().slice(0, 10);

// 銀行の CSV は Shift_JIS が多い。UTF-8 として読めなければ Shift_JIS で読む
async function readCsvText(file) {
  const buffer = await file.arrayBuffer();
  try { return new TextDecoder('utf-8', {fatal: true}).decode(buffer); } catch { return new TextDecoder('shift_jis').decode(buffer); }
}

export default function Cashbook({request}) {
  const [summary, setSummary] = useState(null);
  const [accountId, setAccountId] = useState(null);
  const [detail, setDetail] = useState(null);
  const [error, setError] = useState(null);
  const [message, setMessage] = useState(null);
  const [adding, setAdding] = useState(false);

  const loadSummary = useCallback(async () => {
    setError(null);
    try {
      const data = await request('/cashbook');
      setSummary(data);
      setAccountId((current) => current ?? data.accounts[0]?.id ?? null);
    } catch (failure) { setError(failure); }
  }, [request]);
  const loadDetail = useCallback(async (id) => {
    if (id == null) { setDetail(null); return; }
    try { setDetail(await request(`/cashbook/accounts/${id}`)); } catch (failure) { setError(failure); }
  }, [request]);
  useEffect(() => { loadSummary(); }, [loadSummary]);
  useEffect(() => { loadDetail(accountId); }, [accountId, loadDetail]);
  const reload = async () => { await loadSummary(); await loadDetail(accountId); };
  const act = async (fn) => {
    setError(null); setMessage(null);
    try { await fn(); } catch (failure) { setError(failure); }
  };

  if (!summary) return <section className="cb">{error ? <Notice error={error} onRetry={loadSummary} retryLabel="読み直す" /> : <p aria-busy="true">読込中…</p>}</section>;
  const total = summary.accounts.reduce((acc, a) => ({book: acc.book + a.bookBalanceYen, bank: acc.bank + (a.bankBalanceYen ?? 0)}), {book: 0, bank: 0});

  return (
    <section className="cb" data-page="cashbook">
      {error && <Notice error={error} onRetry={reload} retryLabel="読み直す" />}
      {message && <p className="cb-note" role="status">{message}</p>}
      {!summary.hasCashAccount && <p className="cb-stop">勘定科目「現預金」がありません（PL・BS で初期の勘定科目を作る）</p>}

      <table className="cb-table cb-summary">
        <thead><tr><th>口座</th><th className="n">履歴の残高</th><th className="n">銀行の残高</th><th>照合</th><th className="n">未分類</th></tr></thead>
        <tbody>
          {summary.accounts.map((a) => (
            <tr key={a.id} className={`cb-row ${a.id === accountId ? 'on' : ''}`} onClick={() => setAccountId(a.id)}>
              <td>{a.label}{a.last4 ? <span className="cb-sub">…{a.last4}</span> : null}</td>
              <td className="n">{yen(a.bookBalanceYen)}</td>
              <td className="n">{a.bankBalanceYen == null ? '—' : yen(a.bankBalanceYen)}{a.bankAsOf ? <span className="cb-sub">{a.bankAsOf.slice(5)}</span> : null}</td>
              <td>{a.diffYen == null ? <span className="cb-tag mute">明細なし</span> : a.diffYen === 0 ? <span className="cb-tag">一致</span> : <span className="cb-tag stop">差 {yen(a.diffYen)}</span>}</td>
              <td className="n">{a.unclassified ? <span className="cb-tag now">! {a.unclassified}</span> : ''}</td>
            </tr>
          ))}
          {summary.accounts.length > 1 && <tr className="cb-total"><td>計</td><td className="n">{yen(total.book)}</td><td className="n">{yen(total.bank)}</td><td></td><td></td></tr>}
        </tbody>
      </table>
      <p><button type="button" className="cb-btn" onClick={() => setAdding((v) => !v)} disabled={!summary.hasCashAccount}>口座を足す</button></p>
      {adding && <AddAccount onCancel={() => setAdding(false)} onSave={(payload) => act(async () => {
        const result = await request('/cashbook/accounts', {method: 'POST', body: payload});
        setAdding(false); setAccountId(result.id); await loadSummary();
      })} />}

      {detail && <AccountDetail detail={detail} items={summary.items} request={request} act={act} setMessage={setMessage} reload={reload} />}
    </section>
  );
}

function AddAccount({onSave, onCancel}) {
  const [form, setForm] = useState({label: '', bankName: '', last4: '', openedOn: today(), openingBalanceYen: '0'});
  const set = (key) => (event) => setForm({...form, [key]: event.target.value});
  return (
    <form className="cb-form" onSubmit={(event) => { event.preventDefault(); onSave({...form, openingBalanceYen: form.openingBalanceYen.replace(/[,\s]/g, '')}); }}>
      <label>名前<input id="cb-label" value={form.label} onChange={set('label')} required maxLength={60} /></label>
      <label>銀行<input id="cb-bank" value={form.bankName} onChange={set('bankName')} maxLength={60} /></label>
      <label>下4桁<input id="cb-last4" value={form.last4} onChange={set('last4')} inputMode="numeric" maxLength={4} pattern="\d{4}" /></label>
      <label>開始日<input id="cb-opened" type="date" value={form.openedOn} onChange={set('openedOn')} required /></label>
      <label>開始残高<input id="cb-opening" className="n" value={form.openingBalanceYen} onChange={set('openingBalanceYen')} inputMode="numeric" /></label>
      <button type="submit" className="cb-btn primary">足す</button><button type="button" className="cb-btn" onClick={onCancel}>やめる</button>
    </form>
  );
}

function AccountDetail({detail, items, request, act, setMessage, reload}) {
  const [onlyUnclassified, setOnlyUnclassified] = useState(false);
  const [preview, setPreview] = useState(null);
  const [manual, setManual] = useState(false);
  const base = `/cashbook/accounts/${detail.account.id}`;
  const rows = [...detail.history].reverse().filter((h) => !onlyUnclassified || h.unclassified);

  const onFile = (event) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    act(async () => {
      const text = await readCsvText(file);
      const result = await request(`${base}/preview`, {method: 'POST', body: {fileName: file.name, text}});
      setPreview({...result, fileName: file.name, text});
    });
  };
  const doImport = () => act(async () => {
    const result = await request(`${base}/imports`, {method: 'POST', body: {fileName: preview.fileName, text: preview.text}});
    setPreview(null);
    setMessage(`+${result.newLineCount}${result.duplicateCount ? `（重なり ${result.duplicateCount}）` : ''}`);
    await reload();
  });
  const classify = (entryId, accountId) => act(async () => {
    await request(`/cashbook/entries/${entryId}/classify`, {method: 'POST', body: {accountId: Number(accountId)}});
    await reload();
  });

  return (
    <div className="cb-detail">
      <div className="cb-bar">
        <h2>{detail.account.label}</h2>
        {detail.check.diffYen == null ? <span className="cb-tag mute">明細なし</span>
          : detail.check.diffYen === 0 ? <span className="cb-tag">一致 {detail.check.asOf}</span>
            : <span className="cb-tag stop">銀行 {yen(detail.check.bankBalanceYen)} − 履歴 {yen(detail.check.bookBalanceYen)} ＝ 差 {yen(detail.check.diffYen)}（{detail.check.asOf}）</span>}
        {detail.unclassified > 0 && <span className="cb-tag now">! 未分類 {detail.unclassified}</span>}
        <span style={{flex: 1}} />
        <label className="cb-file">明細を取込<input id="cb-csv" type="file" accept=".csv,text/csv" onChange={onFile} /></label>
        <button type="button" className="cb-btn" onClick={() => setManual((v) => !v)}>手で足す</button>
      </div>

      {preview && (
        <div className="cb-preview">
          <p><b>{preview.fileName}</b> 読めた {preview.lineCount} 行・新しい {preview.newLineCount} 行・重なり {preview.duplicateCount} 行
            {preview.errors.length ? <span className="cb-stop">・読めない {preview.errors.length} 行</span> : null}
            {preview.alreadyImported ? <span className="cb-stop">・同じ明細は受け取り済み</span> : null}</p>
          {preview.errors.length > 0 && <ul className="cb-errors">{preview.errors.slice(0, 20).map((e) => <li key={e.row}>{e.row} 行目: {e.message}</li>)}</ul>}
          <button type="button" className="cb-btn primary" onClick={doImport} disabled={preview.errors.length > 0 || preview.alreadyImported || preview.newLineCount === 0}>取り込む</button>
          <button type="button" className="cb-btn" onClick={() => setPreview(null)}>やめる</button>
        </div>
      )}
      {manual && <ManualEntry items={items} onCancel={() => setManual(false)} onSave={(payload) => act(async () => {
        await request(`${base}/manual`, {method: 'POST', body: payload}); setManual(false); await reload();
      })} />}

      <p className="cb-filter"><label><input id="cb-only" type="checkbox" checked={onlyUnclassified} onChange={(e) => setOnlyUnclassified(e.target.checked)} /> 未分類だけ（{detail.unclassified}）</label></p>
      <table className="cb-table">
        <thead><tr><th>日付</th><th>項目</th><th>摘要</th><th className="n">入金</th><th className="n">出金</th><th className="n">残高</th></tr></thead>
        <tbody>
          {rows.map((h) => (
            <tr key={h.entryId} className={h.unclassified ? 'warn' : ''}>
              <td>{h.date}</td>
              <td>{h.sourceKind === 'opening' ? '開始残高' : (
                <select id={`cb-item-${h.entryId}`} value="" onChange={(e) => e.target.value && classify(h.entryId, e.target.value)} aria-label="項目">
                  <option value="">{h.unclassified ? '未分類 ▾' : `${h.items.join('・')} ▾`}</option>
                  {items.map((i) => <option key={i.id} value={i.id}>{i.code} {i.name}</option>)}
                </select>
              )}</td>
              <td className="cb-desc">{h.description ?? ''}</td>
              <td className="n">{yen(h.inYen)}</td>
              <td className="n">{yen(h.outYen)}</td>
              <td className="n">{yen(h.balanceYen)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function ManualEntry({items, onSave, onCancel}) {
  const [form, setForm] = useState({date: today(), direction: 'out', amountYen: '', accountId: '', memo: ''});
  const set = (key) => (event) => setForm({...form, [key]: event.target.value});
  return (
    <form className="cb-form" onSubmit={(event) => { event.preventDefault(); onSave({...form, amountYen: form.amountYen.replace(/[,\s]/g, ''), accountId: Number(form.accountId)}); }}>
      <label>日付<input id="cb-m-date" type="date" value={form.date} onChange={set('date')} required /></label>
      <label>向き<select id="cb-m-dir" value={form.direction} onChange={set('direction')}><option value="in">入金</option><option value="out">出金</option></select></label>
      <label>額<input id="cb-m-amount" className="n" value={form.amountYen} onChange={set('amountYen')} inputMode="numeric" required /></label>
      <label>項目<select id="cb-m-item" value={form.accountId} onChange={set('accountId')} required>
        <option value="">選ぶ</option>{items.map((i) => <option key={i.id} value={i.id}>{i.code} {i.name}</option>)}
      </select></label>
      <label>摘要<input id="cb-m-memo" value={form.memo} onChange={set('memo')} maxLength={300} /></label>
      <button type="submit" className="cb-btn primary">足す</button><button type="button" className="cb-btn" onClick={onCancel}>やめる</button>
    </form>
  );
}
