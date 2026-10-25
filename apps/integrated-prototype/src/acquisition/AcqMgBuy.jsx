// 業務画面「MG 買付」（支払う MG。会社ルートの plans/2026-10-22-folder-mg-buy.md の香盤表 #5、問い2 A）。
// 契約の一覧 → 1契約を開くと、判定の1行・重要な数字・例外・検査の順に出す。回収の値は受け口が売上明細から毎回計算したもの。
// 結び付けの候補は、作品と期間で1つに決まるものだけ「結ぶ」を押せる（問い3 A）。決まらないものは理由を書いて人が決める。
// 締め月（画面上の「締め月」）の分配報告書の下書きを見て、発行・取消する。受け口は src/acquisition/acq-mg-routes.mjs。支払（MG の前払・分配額）の記録と取消も出す。原本はまだ出さない。
import React, {useCallback, useEffect, useState} from 'react';
import {useShell} from '../shell/context.mjs';
import {Notice} from '../ui/Notice.jsx';
import {yen} from '../ui/format.mjs';
import {todayJst} from '../billing/receipt-model.mjs';
import './acq-mg.css';
import {ContractForm, ManualLink} from './AcqMgForms.jsx';

const STATUS = {recouping: '回収中', recouped: '超過', buyout: '買切', hold: '保留'};
const EXCEPTION = {
  work_not_in_term: '対象外の作品', media_not_allocated: '配分の無い媒体', quantity_price_mismatch: '数量×単価が合わない',
  deduction_cap_exceeded: '費目の上限を超過', deduction_not_in_contract: '契約に無い費目',
};
const CHECK = {
  recouped_plus_balance: '回収累計＋残高＝MG', distribution_formula: '分配額の式', work_shares_sum: '作品ごとの和', quantity_price: '数量×単価',
  deduction_cap: '費目の上限', allocation_sum: '配分の和', payment_schedule_sum: '支払予定の和',
};
const thisMonth = () => todayJst().slice(0, 7);
const money = (v) => (v == null ? '—' : yen(v));

function Verdict({recoup}) {
  if (!recoup) return <span className="muted">条件版なし</span>;
  const bad = recoup.exceptionCount ?? recoup.exceptions?.length ?? 0;
  const passed = recoup.checksPassed ?? recoup.checks?.filter((c) => c.ok).length ?? 0;
  const total = recoup.checksTotal ?? recoup.checks?.length ?? 0;
  return (
    <span className={bad || passed < total ? 'acq-verdict ng' : 'acq-verdict ok'}>
      {bad || passed < total ? `! 要確認 ${bad || total - passed}` : `✓ ${STATUS[recoup.status] ?? recoup.status}`}
      <span className="acq-tag">検査 {passed}/{total}</span>
      {bad || passed < total ? <span className="acq-tag">{STATUS[recoup.status] ?? recoup.status}</span> : null}
    </span>
  );
}

function Detail({detail}) {
  const r = detail.recoup;
  if (!r) return <p className="muted">条件版なし</p>;
  const nums = [['MG の額', r.mgAmount], ['回収累計', r.recouped], ['残高', r.balance], ['超過', r.overage], ['分配額', r.distribution], ['回収の元', r.gross], ['控除', r.deducted], ['売上の行', null, r.lineCount]];
  return (
    <div className="stack">
      <div><Verdict recoup={r} /></div>
      <div className="acq-nums">
        {nums.map(([label, value, count]) => <div key={label}><span>{label}</span><b>{count != null ? count : money(value)}</b></div>)}
      </div>
      {!r.statementAllowed && <Notice tone="info">全体が超過するまで、報告書を出さない契約です（約束の根拠あり）。</Notice>}
      {r.exceptions.length > 0 && (
        <div className="stack">
          {r.exceptions.map((e, index) => <div key={index} className="acq-exception">{EXCEPTION[e.kind] ?? e.kind}{e.saleId ? `（${e.saleId}）` : ''}{e.category ? `（${e.category}）` : ''}</div>)}
        </div>
      )}
      <details>
        <summary>検査 {r.checks.filter((c) => c.ok).length}/{r.checks.length}</summary>
        <ul>{r.checks.map((c) => <li key={c.key} className={c.ok ? '' : 'acq-ng'}>{c.ok ? '✓' : '✗'} {CHECK[c.key] ?? c.key}</li>)}</ul>
      </details>
      <details>
        <summary>結び付け {detail.links.length}</summary>
        <table className="acq-table"><thead><tr><th>報告</th><th>作品</th><th>決め方</th><th>判断</th><th>理由</th></tr></thead>
          <tbody>{detail.links.map((l) => <tr key={l.id}><td>{l.report_id}</td><td>{l.work_id}</td><td>{l.decided_by === 'auto' ? '自動' : '人'}</td><td>{l.decision === 'include' ? '入れる' : '外す'}</td><td>{l.reason}</td></tr>)}</tbody>
        </table>
      </details>
    </div>
  );
}

// 締め月の分配報告書（問い4 A: 締め月を指して下書きを見て、人が発行を押す。送るのは人の手）
function Statements({request, contractId, closeMonth, readOnly}) {
  const [data, setData] = useState({statements: [], draft: null});
  const [state, setState] = useState({error: null, notice: null});
  const load = useCallback(async () => {
    try { setData(await request(`/acq-mg/contracts/${contractId}/statements?closeMonth=${closeMonth}`)); }
    catch (error) { setState({error, notice: null}); }
  }, [request, contractId, closeMonth]);
  useEffect(() => { load(); }, [load]);
  const issue = async () => {
    try {
      await request(`/acq-mg/contracts/${contractId}/statements`, {method: 'POST', body: JSON.stringify({closeMonth, expectedSha256: data.draft?.sha256})});
      setState({error: null, notice: `${closeMonth} の報告書を発行しました`});
      await load();
    } catch (error) { setState({error, notice: null}); }
  };
  const voidOne = async (statement) => {
    const reason = window.prompt('取り消す理由');
    if (!reason) return;
    try {
      await request(`/acq-mg/statements/${statement.id}/void`, {method: 'POST', body: JSON.stringify({reason})});
      setState({error: null, notice: `${statement.close_month} の報告書を取り消しました`});
      await load();
    } catch (error) { setState({error, notice: null}); }
  };
  const draft = data.draft;
  const live = data.statements.find((s) => s.kind === 'issue' && !s.voided && s.close_month === closeMonth);
  return (
    <div className="stack">
      <h4>報告書 {closeMonth}</h4>
      {state.error && <Notice error={state.error} />}
      {state.notice && <Notice tone="ok" message={state.notice} />}
      {live ? <span className="acq-verdict ok">✓ 発行済み <span className="acq-tag">{live.issued_on}</span></span>
        : draft && (draft.gate.ok
          ? <div className="stack">
              <span className="acq-verdict ok">✓ 発行待ち <span className="acq-tag">{draft.body.distributionLabel ?? STATUS[draft.body.status]}</span></span>
              <div className="acq-nums">
                <div><span>当期の回収</span><b>{money(draft.body.increment.recouped)}</b></div>
                <div><span>回収累計</span><b>{money(draft.body.amounts.recouped)}</b></div>
                <div><span>残高</span><b>{money(draft.body.amounts.balance)}</b></div>
                <div><span>分配額</span><b>{draft.body.distributionLabel ?? money(draft.body.amounts.distribution)}</b></div>
              </div>
              <div><button type="button" disabled={readOnly} onClick={issue}>発行</button></div>
            </div>
          : <div className="acq-exception">発行できません: {draft.gate.reason}</div>)}
      {data.statements.length > 0 && (
        <table className="acq-table"><thead><tr><th>締め月</th><th>種類</th><th>回収累計</th><th>分配額</th><th>日付</th><th></th></tr></thead>
          <tbody>{data.statements.map((st) => (
            <tr key={st.id} className={st.voided ? 'muted' : ''}>
              <td>{st.close_month}</td><td>{st.kind === 'issue' ? (st.voided ? '発行（取消済み）' : '発行') : '取消'}</td>
              <td>{money(st.recouped)}</td><td>{money(st.distribution)}</td><td>{st.issued_on}</td>
              <td>{st.kind === 'issue' && !st.voided && <button type="button" disabled={readOnly} onClick={() => voidOne(st)}>取消</button>}</td>
            </tr>))}</tbody>
        </table>
      )}
    </div>
  );
}

// 支払（MG の前払は支払予定の回ごと、分配額は最新の報告書に対して）。画面は円の支払だけ。外貨は受け口で受ける
const KIND = {mg_advance: 'MG の前払', distribution: '分配額'};
const TRIGGER = {signing: '署名', delivery: '納品', release: '公開', date: '日付'};
function Payments({request, contractId, readOnly}) {
  const [data, setData] = useState(null);
  const [form, setForm] = useState({kind: 'mg_advance', installment: '', amountYen: '', paidOn: todayJst(), reference: '', reason: ''});
  const [state, setState] = useState({error: null, notice: null});
  const load = useCallback(async () => {
    try { setData(await request(`/acq-mg/contracts/${contractId}/payments`)); } catch (error) { setState({error, notice: null}); }
  }, [request, contractId]);
  useEffect(() => { load(); }, [load]);
  if (!data) return null;
  const s = data.summary;
  const set = (key) => (e) => setForm((f) => ({...f, [key]: e.target.value}));
  const save = async () => {
    try {
      const payload = {...form, amountYen: Number(form.amountYen), installment: form.kind === 'mg_advance' ? form.installment : '', statementId: form.kind === 'distribution' ? data.latestStatementId : ''};
      await request(`/acq-mg/contracts/${contractId}/payments`, {method: 'POST', body: JSON.stringify(payload)});
      setState({error: null, notice: `${KIND[form.kind]} ${yen(Number(form.amountYen))} を記録しました`});
      setForm((f) => ({...f, amountYen: '', reference: '', reason: ''}));
      await load();
    } catch (error) { setState({error, notice: null}); }
  };
  const reverse = async (p) => {
    const reason = window.prompt('取り消す理由');
    if (!reason) return;
    try { await request(`/acq-mg/payments/${p.id}/reverse`, {method: 'POST', body: JSON.stringify({reason})}); await load(); } catch (error) { setState({error, notice: null}); }
  };
  const reversed = new Set(data.payments.filter((p) => p.reverses_payment_id).map((p) => p.reverses_payment_id));
  return (
    <div className="stack">
      <h4>支払</h4>
      {state.error && <Notice error={state.error} />}
      {state.notice && <Notice tone="ok" message={state.notice} />}
      <div className="acq-nums">
        <div><span>MG 支払済み</span><b>{money(s.mgPaid)}</b></div>
        <div><span>MG 未払</span><b className={s.mgUnpaid ? 'acq-ng' : ''}>{money(s.mgUnpaid)}</b></div>
        <div><span>分配額</span><b>{money(s.distributionOwed)}</b></div>
        <div><span>分配の未払</span><b className={s.distributionUnpaid ? 'acq-ng' : ''}>{money(s.distributionUnpaid)}</b></div>
      </div>
      {s.installments.length > 0 && (
        <table className="acq-table"><thead><tr><th>回</th><th>きっかけ</th><th>予定</th><th>支払済み</th><th>残り</th></tr></thead>
          <tbody>{s.installments.map((r) => <tr key={r.installment}><td>{r.installment}</td><td>{TRIGGER[r.trigger] ?? r.trigger}</td><td>{money(r.amount)}</td><td>{money(r.paid)}</td><td className={r.unpaid ? 'acq-ng' : ''}>{money(r.unpaid)}</td></tr>)}</tbody>
        </table>
      )}
      {!readOnly && (
        <div className="acq-form">
          <select value={form.kind} onChange={set('kind')} aria-label="種類"><option value="mg_advance">MG の前払</option><option value="distribution" disabled={!data.latestStatementId}>分配額</option></select>
          {form.kind === 'mg_advance' && s.installments.length > 0 && (
            <select value={form.installment} onChange={set('installment')} aria-label="回"><option value="">回</option>{s.installments.map((r) => <option key={r.installment} value={r.installment}>{r.installment}（{TRIGGER[r.trigger] ?? r.trigger}）</option>)}</select>
          )}
          <input type="number" min="1" step="1" placeholder="円" value={form.amountYen} onChange={set('amountYen')} aria-label="円の額" />
          <input type="date" value={form.paidOn} onChange={set('paidOn')} aria-label="支払日" />
          <input placeholder="参照（振込の番号）" value={form.reference} onChange={set('reference')} aria-label="参照" />
          <input placeholder="理由" value={form.reason} onChange={set('reason')} aria-label="理由" />
          <button type="button" onClick={save}>記録</button>
        </div>
      )}
      {data.payments.length > 0 && (
        <table className="acq-table"><thead><tr><th>支払日</th><th>種類</th><th>回</th><th>円</th><th>参照</th><th></th></tr></thead>
          <tbody>{data.payments.map((p) => (
            <tr key={p.id} className={p.reverses_payment_id || reversed.has(p.id) ? 'muted' : ''}>
              <td>{p.paid_on}</td><td>{p.reverses_payment_id ? `取消（${KIND[p.kind]}）` : KIND[p.kind]}</td><td>{p.installment ?? ''}</td><td>{money(p.amount_yen)}</td><td>{p.reference}</td>
              <td>{!p.reverses_payment_id && !reversed.has(p.id) && !readOnly && <button type="button" onClick={() => reverse(p)}>取消</button>}</td>
            </tr>))}</tbody>
        </table>
      )}
    </div>
  );
}

export default function AcqMgBuy({request: requestProp, data: shellData}) {
  const shell = useShell();
  const request = requestProp || shell.request;
  const readOnly = Boolean(shell.readOnly);
  const [asOf, setAsOf] = useState(thisMonth());
  const [list, setList] = useState([]);
  const [candidates, setCandidates] = useState([]);
  const [creating, setCreating] = useState(false);
  const [selected, setSelected] = useState(null);
  const [detail, setDetail] = useState(null);
  const [state, setState] = useState({loading: true, error: null, notice: null});

  const load = useCallback(async () => {
    setState((s) => ({...s, loading: true, error: null}));
    try {
      const [contracts, links] = await Promise.all([request(`/acq-mg/contracts?asOf=${asOf}`), request('/acq-mg/link-candidates')]);
      setList(contracts.contracts || []);
      setCandidates(links.candidates || []);
      setState((s) => ({...s, loading: false}));
    } catch (error) { setState((s) => ({...s, loading: false, error})); }
  }, [request, asOf]);
  useEffect(() => { load(); }, [load]);

  useEffect(() => {
    if (!selected) { setDetail(null); return; }
    let live = true;
    request(`/acq-mg/contracts/${selected}?asOf=${asOf}`).then((d) => { if (live) setDetail(d); }, (error) => { if (live) setState((s) => ({...s, error})); });
    return () => { live = false; };
  }, [request, selected, asOf, list]);

  const autoLink = async (candidate) => {
    try {
      await request('/acq-mg/report-links', {method: 'POST', body: JSON.stringify({reportId: candidate.reportId, workId: candidate.workId, termVersionId: candidate.termVersionIds[0], decidedBy: 'auto', reportBasis: 'net'})});
      setState((s) => ({...s, notice: `報告 ${candidate.reportKey} を結びました`}));
      await load();
    } catch (error) { setState((s) => ({...s, error})); }
  };

  return (
    <div className="stack acq-mg">
      <section className="card">
        <div className="acq-head">
          <h2>MG 買付</h2>
          {!readOnly && !creating && <button type="button" onClick={() => setCreating(true)}>契約を登録</button>}
          <label>締め月 <input type="month" value={asOf} onChange={(e) => setAsOf(e.target.value || thisMonth())} /></label>
        </div>
        {state.error && <Notice error={state.error} />}
        {state.notice && <Notice tone="ok" message={state.notice} />}
        {creating && <ContractForm request={request} partners={shellData?.partners || []} works={shellData?.works || []}
          onCancel={() => setCreating(false)} onSaved={async (r) => { setCreating(false); setState((s) => ({...s, notice: '契約を登録しました'})); await load(); setSelected(r.contractId); }} />}
        {state.loading ? <p className="muted">読み込み中…</p> : list.length === 0 ? <p className="muted">契約なし</p> : (
          <table className="acq-table">
            <thead><tr><th>契約</th><th>権利元</th><th>MG</th><th>回収累計</th><th>残高／超過</th><th>分配額</th><th>判定</th></tr></thead>
            <tbody>
              {list.map((k) => (
                <tr key={k.id} className={selected === k.id ? 'selected' : ''} onClick={() => setSelected(k.id)} style={{cursor: 'pointer'}}>
                  <td>{k.code} {k.title}</td><td>{k.partnerName}</td><td>{money(k.mgAmount)}</td><td>{money(k.recoup?.recouped)}</td>
                  <td>{k.recoup ? (k.recoup.overage > 0 ? `超過 ${money(k.recoup.overage)}` : money(k.recoup.balance)) : '—'}</td>
                  <td>{money(k.recoup?.distribution)}</td><td><Verdict recoup={k.recoup} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
      {detail && (
        <section className="card">
          <h3>{detail.contract.code} {detail.contract.title}<span className="muted">（版 {detail.versions.length}・{detail.contract.partnerName}）</span></h3>
          <Detail detail={detail} />
          <Statements request={request} contractId={detail.contract.id} closeMonth={asOf} readOnly={readOnly} />
          <Payments request={request} contractId={detail.contract.id} readOnly={readOnly} />
        </section>
      )}
      <section className="card">
        <h3>候補 {candidates.length}</h3>
        {candidates.length === 0 ? <p className="muted">候補なし</p> : (
          <table className="acq-table">
            <thead><tr><th>報告</th><th>作品</th><th>計上月</th><th>期間</th><th></th></tr></thead>
            <tbody>
              {candidates.map((cand) => (
                <tr key={`${cand.reportId}:${cand.workId}`} className={cand.autoLinkable ? '' : 'acq-ng'}>
                  <td>{cand.reportKey}</td><td>{cand.workId}</td><td>{cand.accountingMonth}</td><td>{cand.periodFrom}〜{cand.periodTo}</td>
                  <td>{cand.autoLinkable ? <button type="button" disabled={readOnly} onClick={() => autoLink(cand)}>結ぶ</button>
                    : <div className="stack"><span>{cand.reason}</span>{!readOnly && <ManualLink request={request} candidate={cand} contracts={list} onDone={load} />}</div>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </div>
  );
}
