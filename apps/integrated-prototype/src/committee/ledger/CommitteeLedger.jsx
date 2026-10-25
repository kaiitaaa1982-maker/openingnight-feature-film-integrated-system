// 製作委員会の契約の式・台帳の画面（要件 docs/requirements/settlement/committee.md。会社ルートの plans/2026-10-23-committee-terms-ledger.md）。
// 契約を選ぶと、収支（前回まで累計・今回・累計）・累計（当事者・著作権者・成功報酬・業務担当者）・日程（2段の回）・式・入力（届いた報告書の全行）を切り替えて見る。
// 値は受け口（/api/committee/ledger/…）から読むだけで、合計・累計・回の日付は受け口が台帳と式から導いたものを出す。画面で計算し直さない。
// 見た目は core docs/design/integrated-system-visual.md（黒・白・灰＋赤1色）。
import React, {useCallback, useEffect, useMemo, useState} from 'react';
import {Notice} from '../../ui/Notice.jsx';
import './committee-ledger.css';

const yen = (value) => (value == null ? '—' : Number(value).toLocaleString('ja-JP'));
const TABS = [['statement', '収支'], ['cumulative', '累計'], ['schedule', '日程'], ['formula', '式'], ['input', '入力']];
const TIER_LABEL = {to_members: '幹事→当事者', to_manager: '業務担当者→幹事'};
const BUSINESS_LABEL = {theatrical: '劇場', program: 'プログラム', non_theatrical: '非劇場', home_video: 'ビデオグラム', commercial_video: '業務用ビデオ', internet: '自動公衆送信',
  tv: 'テレビ放送', ancillary: '付随的権利', publishing: '書籍化', merchandising: '商品化', overseas: '海外', music_master: '音楽原盤', music_publishing: '音楽出版', other: 'その他'};
const SECTION_LABEL = {income: '収入', expense: '支出', secondary_royalty: '権利処理費', agent_fee: '業務手数料', other_income: 'その他収入', overhead: '委員会経費',
  manager_fee: '幹事手数料', success_fee: '成功報酬', member_distribution: '当事者への配分'};
const ROLE_LABEL = {original: '原作', director: '監督', screenplay: '脚本', music: '音楽', other: 'その他'};
const BUSINESS_SECTIONS = ['income', 'expense', 'secondary_royalty', 'agent_fee'];

function Three({label, v, className}) {
  return <tr className={className}><td>{label}</td><td className="n">{yen(v?.prior)}</td><td className="n">{yen(v?.current)}</td><td className="n">{yen(v?.cumulative)}</td></tr>;
}

export default function CommitteeLedger({request}) {
  const [works, setWorks] = useState(null);
  const [contractId, setContractId] = useState(null);
  const [tier, setTier] = useState('to_members');
  const [closeOn, setCloseOn] = useState('');
  const [asOf, setAsOf] = useState('');
  const [tab, setTab] = useState('statement');
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  useEffect(() => {
    request('/reports/committee-monthly/works').then((r) => {
      setWorks(r.works);
      if (r.works.length && contractId == null) setContractId(r.works[0].latestContractId);
    }).catch(setError);
  }, [request]); // eslint-disable-line react-hooks/exhaustive-deps
  const load = useCallback(async () => {
    if (contractId == null) return;
    setError(null);
    const q = new URLSearchParams({tier, ...(closeOn ? {closeOn} : {}), ...(/^\d{4}-\d{2}-\d{2}$/.test(asOf) ? {asOf} : {})});
    try { setData(await request(`/committee/ledger/contracts/${contractId}?${q}`)); } catch (failure) { setError(failure); }
  }, [request, contractId, tier, closeOn, asOf]);
  useEffect(() => { load(); }, [load]);
  const partnerName = useMemo(() => {
    const m = new Map((data?.partners ?? []).map((p) => [p.id, p.name]));
    return (id) => (id == null ? '—' : m.get(Number(id)) ?? `取引先${id}`);
  }, [data]);

  return (
    <section className="cl" data-page="committee-ledger">
      {error && <Notice error={error} onRetry={load} retryLabel="読み直す" />}
      {works && !works.length && <p className="cl-note">契約なし</p>}
      {works && works.length > 0 && (
        <div className="cl-bar">
          <select aria-label="契約" value={contractId ?? ''} onChange={(e) => { setContractId(Number(e.target.value)); setCloseOn(''); }}>
            {works.map((w) => <option key={w.latestContractId} value={w.latestContractId}>{w.code} {w.title}</option>)}
          </select>
          <select aria-label="段" value={tier} onChange={(e) => { setTier(e.target.value); setCloseOn(''); }}>
            {Object.entries(TIER_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </select>
          <label className="cl-note">基準日 <input aria-label="日程の基準日" placeholder="今日" value={asOf} onChange={(e) => setAsOf(e.target.value)} size={11} /></label>
          {data?.closes?.length > 0 && (
            <select aria-label="回" value={data.closeOn ?? ''} onChange={(e) => setCloseOn(e.target.value)}>
              {data.closes.map((d) => <option key={d} value={d}>{d} 締め</option>)}
            </select>
          )}
        </div>
      )}
      <div className="cl-tabs" role="tablist">
        {TABS.map(([k, label]) => <button key={k} type="button" aria-pressed={tab === k} onClick={() => setTab(k)}>{label}</button>)}
      </div>
      {data && tab === 'statement' && <Statement data={data} partnerName={partnerName} />}
      {data && tab === 'cumulative' && <Cumulatives data={data} partnerName={partnerName} />}
      {data && tab === 'schedule' && <Schedule data={data} request={request} contractId={contractId} onSaved={load} />}
      {data && tab === 'formula' && <Formula data={data} partnerName={partnerName} />}
      {data && tab === 'input' && <ReceivedInput data={data} request={request} contractId={contractId} tier={tier} onSaved={load} />}
    </section>
  );
}

function Statement({data, partnerName}) {
  const s = data.statement;
  if (!s) return <p className="cl-note">行なし</p>;
  return (
    <>
      <table className="cl-table">
        <thead><tr><th>摘要</th><th className="n">前回まで累計</th><th className="n">今回</th><th className="n">累計</th></tr></thead>
        <tbody>
          {s.byBusiness.map((b) => (
            <React.Fragment key={b.business}>
              <tr className="grp"><td colSpan={4}>{BUSINESS_LABEL[b.business] ?? b.business}</td></tr>
              {BUSINESS_SECTIONS.map((sec) => <Three key={sec} label={`　${SECTION_LABEL[sec]}`} v={b[sec]} />)}
              <Three label="　配分金" v={b.distribution} className="sum" />
            </React.Fragment>
          ))}
          <Three label="配分金合計 A" v={s.A} className="sum" />
          <Three label="その他収入 B" v={s.B} />
          <Three label="委員会経費 C" v={s.C} className="sum" />
          <Three label="　うち委員会経費" v={s.costs.overhead} />
          <Three label="　うち幹事手数料" v={s.costs.manager_fee} />
          <Three label="　うち成功報酬" v={s.costs.success_fee} />
          <Three label="委員会配分 D＝A＋B−C" v={s.D} className="sum" />
          <Three label={`出資金総額 E${data.investmentTotalYen == null ? '（未確認）' : ''}`} v={s.E} />
          <Three label="委員会収支 D−E" v={s.balance} className="sum" />
        </tbody>
      </table>
      <Members rows={data.cumulatives?.members ?? []} partnerName={partnerName} title="当事者への配分" />
    </>
  );
}

function Members({rows, partnerName, title, keyLabel}) {
  if (!rows.length) return null;
  return (
    <table className="cl-table">
      <thead><tr><th>{title}</th><th className="n">前回まで累計</th><th className="n">今回</th><th className="n">累計</th></tr></thead>
      <tbody>{rows.map((r) => <Three key={String(r.key)} label={keyLabel ? keyLabel(r.key) : partnerName(r.key)} v={r} />)}</tbody>
    </table>
  );
}

function Cumulatives({data, partnerName}) {
  const c = data.cumulatives;
  if (!c) return <p className="cl-note">行なし</p>;
  const holder = (key) => { const [role, id] = String(key).split('|'); return `${ROLE_LABEL[role] ?? role}（${id ? partnerName(id) : '相手なし'}）`; };
  return (
    <>
      <Members rows={c.members} partnerName={partnerName} title="当事者" />
      <Members rows={c.holders} partnerName={partnerName} title="著作権者" keyLabel={holder} />
      <Members rows={c.successFee} partnerName={partnerName} title="成功報酬" />
      <Members rows={c.agentFee} partnerName={partnerName} title="窓口手数料" />
    </>
  );
}

function Schedule({data, request, contractId, onSaved}) {
  return (
    <>
      {!data.schedule && <p className="cl-note">版なし</p>}
      {data.schedule && <p className="cl-note">版 {data.schedule.versionNo}・{data.schedule.effectiveFrom}〜・起点 {data.schedule.baseDate}</p>}
      {data.scheduleError && <div className="cl-alert">{data.scheduleError}</div>}
      {Object.entries(data.rounds).filter(([, list]) => list.length).map(([t, list]) => (
        <table key={t} className="cl-table">
          <thead><tr><th>{TIER_LABEL[t]}</th><th>締め</th><th>報告</th><th>支払</th><th>変更</th></tr></thead>
          <tbody>{list.map((r, i) => (
            <tr key={r.closeOn}><td>{i + 1}{r.yearIndex ? <span className="cl-tag">{r.yearIndex}年目</span> : null}</td><td>{r.closeOn}</td><td>{r.reportOn}</td>
              <td className={r.overrides.length ? 'cl-red' : ''}>{r.payOn}</td><td>{r.overrides.map((o) => <span key={o.field} className="cl-tag red" title={o.reason}>{o.field === 'payOn' ? '支払日' : o.field === 'reportOn' ? '報告日' : '飛ばす'}</span>)}</td></tr>
          ))}</tbody>
        </table>
      ))}
      {data.schedule && <OverrideForm data={data} request={request} contractId={contractId} onSaved={onSaved} />}
      <ScheduleForm key={data.schedule?.versionNo ?? 0} request={request} contractId={contractId} onSaved={onSaved} current={data.schedule} />
    </>
  );
}

// その回だけの変更（報告日・支払日・回を飛ばす）。理由は必須。同じ回×項目は後に入れた行が効く
function OverrideForm({data, request, contractId, onSaved}) {
  const [form, setForm] = useState({tier: 'to_members', closeOn: '', field: 'pay_on', valueOn: '', reason: ''});
  const [result, setResult] = useState(null);
  const set = (k, v) => setForm((f) => ({...f, [k]: v}));
  const closes = data.rounds[form.tier] ?? [];
  const submit = async () => {
    setResult(null);
    try {
      await request(`/committee/ledger/contracts/${contractId}/round-overrides`, {method: 'POST', body: {...form, valueOn: form.field === 'skip' ? null : form.valueOn}});
      setResult(null);
      onSaved();
    } catch (failure) { setResult({ok: false, text: failure.message}); }
  };
  return (
    <details className="cl-lane"><summary className="cl-lane-head">回だけの変更を入れる</summary>
      <div className="cl-bar cl-pad">
        <select aria-label="変更の段" value={form.tier} onChange={(e) => set('tier', e.target.value)}>{Object.entries(TIER_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select>
        <select aria-label="変更する回" value={form.closeOn} onChange={(e) => set('closeOn', e.target.value)}><option value="">回を選ぶ</option>{closes.map((r) => <option key={r.closeOn} value={r.closeOn}>{r.closeOn} 締め</option>)}</select>
        <select aria-label="変える項目" value={form.field} onChange={(e) => set('field', e.target.value)}><option value="pay_on">支払日</option><option value="report_on">報告日</option><option value="skip">この回を飛ばす</option></select>
        {form.field !== 'skip' && <input aria-label="変更後の日" placeholder="YYYY-MM-DD" size={11} value={form.valueOn} onChange={(e) => set('valueOn', e.target.value)} />}
        <input aria-label="理由" placeholder="理由" value={form.reason} onChange={(e) => set('reason', e.target.value)} />
        <button type="button" className="pri" disabled={!form.closeOn || !form.reason.trim()} onClick={submit}>入れる</button>
      </div>
      {result && <p className="cl-alert">{result.text}</p>}
    </details>
  );
}

// 日程の版を足す。段×フェーズの行（締めの月・報告・支払・繰越・休業日）。今の版があれば、その内容を初期値にする
const blankPhase = (tier = 'to_members') => ({tier, fromYear: 1, toYear: '', closeMonths: tier === 'to_members' ? [2, 5, 8, 11] : [3, 6, 9, 12], reportOffsetMonths: 2, payFrom: 'report', payOffsetMonths: 1, carryUnderYen: '', holidayRule: 'previous_business_day'});
function ScheduleForm({request, contractId, onSaved, current}) {
  const [form, setForm] = useState(() => ({effectiveFrom: '', baseKind: current?.baseKind ?? 'release', baseDate: current?.baseDate ?? '', reason: '',
    phases: current?.phases?.length ? current.phases.map((p) => ({...p, toYear: p.toYear ?? '', carryUnderYen: p.carryUnderYen ?? ''})) : [blankPhase()]}));
  const [result, setResult] = useState(null);
  const set = (k, v) => setForm((f) => ({...f, [k]: v}));
  const setPhase = (i, k, v) => setForm((f) => ({...f, phases: f.phases.map((p, j) => (j === i ? {...p, [k]: v} : p))}));
  const toggleMonth = (i, m) => setForm((f) => ({...f, phases: f.phases.map((p, j) => (j !== i ? p : {...p, closeMonths: p.closeMonths.includes(m) ? p.closeMonths.filter((x) => x !== m) : [...p.closeMonths, m].sort((a, b) => a - b)}))}));
  const submit = async () => {
    setResult(null);
    const phases = form.phases.map((p) => ({tier: p.tier, fromYear: Number(p.fromYear), toYear: p.toYear === '' ? null : Number(p.toYear), closeMonths: p.closeMonths,
      reportOffsetMonths: Number(p.reportOffsetMonths), payFrom: p.payFrom, payOffsetMonths: Number(p.payOffsetMonths), carryUnderYen: p.carryUnderYen === '' ? null : Number(p.carryUnderYen), holidayRule: p.holidayRule}));
    try {
      await request(`/committee/ledger/contracts/${contractId}/schedule-versions`, {method: 'POST', body: {effectiveFrom: form.effectiveFrom, baseKind: form.baseKind, baseDate: form.baseDate, reason: form.reason, phases}});
      setResult(null);
      onSaved();
    } catch (failure) { setResult({ok: false, text: failure.message}); }
  };
  return (
    <details className="cl-lane"><summary className="cl-lane-head">日程の版を足す</summary>
      <div className="cl-bar cl-pad">
        適用開始日 <input aria-label="適用開始日" placeholder="YYYY-MM-DD" size={11} value={form.effectiveFrom} onChange={(e) => set('effectiveFrom', e.target.value)} />
        基準 <select aria-label="基準の種類" value={form.baseKind} onChange={(e) => set('baseKind', e.target.value)}><option value="release">公開日</option><option value="first_sales">初回の売上</option><option value="contract">契約日</option><option value="other">その他</option></select>
        <input aria-label="基準日" placeholder="YYYY-MM-DD" size={11} value={form.baseDate} onChange={(e) => set('baseDate', e.target.value)} />
        <input aria-label="版の理由" placeholder="理由" value={form.reason} onChange={(e) => set('reason', e.target.value)} />
      </div>
      <table className="cl-table">
        <thead><tr><th>段</th><th>年目</th><th>締めの月</th><th>報告（締め＋か月の末日）</th><th>支払</th><th>繰越の下限</th><th>休業日</th><th></th></tr></thead>
        <tbody>{form.phases.map((p, i) => (
          <tr key={i}>
            <td><select aria-label="フェーズの段" value={p.tier} onChange={(e) => setPhase(i, 'tier', e.target.value)}>{Object.entries(TIER_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></td>
            <td><input aria-label="始まりの年" size={2} value={p.fromYear} onChange={(e) => setPhase(i, 'fromYear', e.target.value)} />〜<input aria-label="終わりの年" size={2} placeholder="続く" value={p.toYear} onChange={(e) => setPhase(i, 'toYear', e.target.value)} /></td>
            <td className="cl-months">{[1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12].map((m) => <button key={m} type="button" aria-pressed={p.closeMonths.includes(m)} onClick={() => toggleMonth(i, m)}>{m}</button>)}</td>
            <td>+<input aria-label="報告のか月" size={2} value={p.reportOffsetMonths} onChange={(e) => setPhase(i, 'reportOffsetMonths', e.target.value)} /></td>
            <td><select aria-label="支払の数え始め" value={p.payFrom} onChange={(e) => setPhase(i, 'payFrom', e.target.value)}><option value="report">報告から</option><option value="close">締めから</option></select>+<input aria-label="支払のか月" size={2} value={p.payOffsetMonths} onChange={(e) => setPhase(i, 'payOffsetMonths', e.target.value)} /></td>
            <td><input className="n cl-narrow" aria-label="繰越の下限" placeholder="なし" value={p.carryUnderYen} onChange={(e) => setPhase(i, 'carryUnderYen', e.target.value)} /></td>
            <td><select aria-label="休業日" value={p.holidayRule} onChange={(e) => setPhase(i, 'holidayRule', e.target.value)}><option value="previous_business_day">前の営業日</option><option value="none">そのまま</option></select></td>
            <td><button type="button" onClick={() => setForm((f) => ({...f, phases: f.phases.filter((_, j) => j !== i)}))}>外す</button></td>
          </tr>
        ))}</tbody>
      </table>
      <div className="cl-bar cl-pad">
        <button type="button" onClick={() => setForm((f) => ({...f, phases: [...f.phases, blankPhase('to_manager')]}))}>フェーズを足す</button>
        <button type="button" className="pri" disabled={!form.effectiveFrom || !form.baseDate || !form.reason.trim() || !form.phases.length} onClick={submit}>版を入れる</button>
      </div>
      {result && <p className="cl-alert">{result.text}</p>}
    </details>
  );
}

function Formula({data, partnerName}) {
  const f = data.formula;
  if (!f || (!f.businesses.length && !f.committeeSteps.length)) return <p className="cl-note">式なし</p>;
  const stepText = (s) => s.kind === 'expense' ? ['経費', s.label] : s.kind === 'secondary_royalty' ? ['二次使用料', `${ROLE_LABEL[s.holderRole] ?? s.holderRole}${s.deductExpenses ? '・経費を引く' : ''}`]
    : s.kind === 'agent_fee' ? ['窓口手数料', `${s.base === 'income' ? '収入' : '残り'}×${s.rateBps / 100}%`]
      : s.kind === 'overhead' ? ['委員会経費', s.label] : s.kind === 'manager_fee' ? ['幹事手数料', `${partnerName(s.recipientPartnerId)} ${s.base === 'a' ? 'A' : '残り'}×${s.rateBps / 100}%`]
        : ['成功報酬', `${partnerName(s.recipientPartnerId)} ${s.rateBps / 100}%・${s.mode === 'excess' ? '超えた分' : '回収後'}`];
  const Steps = ({list}) => <div className="cl-steps">{list.map((s, i) => { const [t, d] = stepText(s); return <React.Fragment key={i}>{i > 0 && <span className="cl-arrow">→</span>}<div className="cl-step"><b>{i + 1}. {t}</b>{d}</div></React.Fragment>; })}</div>;
  return (
    <>
      {f.businesses.map((b) => (
        <div key={b.code} className="cl-lane"><div className="cl-lane-head"><b>{BUSINESS_LABEL[b.code] ?? b.code}</b> 業務担当 {partnerName(b.operatorPartnerId)}{b.clauseReference ? <span className="cl-tag">{b.clauseReference}</span> : null}</div><Steps list={b.steps} /></div>
      ))}
      <div className="cl-lane"><div className="cl-lane-head"><b>委員会全体</b>（A＋B から）</div><Steps list={f.committeeSteps} /></div>
      {f.budgetLines.length > 0 && (
        <table className="cl-table"><thead><tr><th>総事業費の内訳</th><th className="n">額</th></tr></thead>
          <tbody>{f.budgetLines.map((l, i) => <tr key={i}><td>{l.label ?? {production: '製作費', pa: 'P&A', contingency: '製作予備費', other: 'その他'}[l.item]}</td><td className="n">{yen(l.amountYen)}</td></tr>)}</tbody></table>
      )}
    </>
  );
}

// 届いた収支報告書の全行を入れる。行ごとに区分・事業・相手・役・額。報告書の「前回まで累計」を入れると台帳と照合する
const blankRow = () => ({section: 'income', business: 'theatrical', counterparty: '', holderRole: 'original', amount: '', item: ''});
function ReceivedInput({data, request, contractId, tier, onSaved}) {
  const [closeOn, setCloseOn] = useState('');
  const [rows, setRows] = useState([blankRow()]);
  const [result, setResult] = useState(null);
  const set = (i, key, value) => setRows((list) => list.map((r, j) => (j === i ? {...r, [key]: value} : r)));
  const report = () => {
    const out = {businesses: [], other_income: [], overhead: [], manager_fee: [], success_fee: [], member_distribution: []};
    for (const r of rows) {
      const amountYen = Number(String(r.amount).replace(/[,，\s円]/g, ''));
      const line = {amountYen, ...(r.item ? {item: r.item} : {}), ...(r.counterparty ? {counterparty: Number(r.counterparty)} : {}), ...(r.section === 'secondary_royalty' ? {holderRole: r.holderRole} : {})};
      if (BUSINESS_SECTIONS.includes(r.section)) {
        let b = out.businesses.find((x) => x.business === r.business);
        if (!b) { b = {business: r.business}; out.businesses.push(b); }
        (b[r.section] ??= []).push(line);
      } else out[r.section].push(line);
    }
    return out;
  };
  const submit = async () => {
    setResult(null);
    try {
      await request(`/committee/ledger/contracts/${contractId}/rounds/received`, {method: 'POST', body: {tier, closeOn, report: report()}});
      setResult(null);
      setRows([blankRow()]);
      onSaved();
    } catch (failure) {
      const d = failure.details ?? failure.body?.details;
      setResult({ok: false, text: failure.message, diff: d?.diffYen ?? null});
    }
  };
  return (
    <>
      <div className="cl-bar">締め日 <input aria-label="締め日" placeholder="YYYY-MM-DD" value={closeOn} onChange={(e) => setCloseOn(e.target.value)} /></div>
      <table className="cl-table">
        <thead><tr><th>区分</th><th>事業</th><th>相手</th><th>役</th><th className="n">額（税抜）</th><th>項目</th><th></th></tr></thead>
        <tbody>{rows.map((r, i) => (
          <tr key={i}>
            <td><select aria-label="区分" value={r.section} onChange={(e) => set(i, 'section', e.target.value)}>{Object.entries(SECTION_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></td>
            <td>{BUSINESS_SECTIONS.includes(r.section) ? <select aria-label="事業" value={r.business} onChange={(e) => set(i, 'business', e.target.value)}>{Object.entries(BUSINESS_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select> : '—'}</td>
            <td><select aria-label="相手" value={r.counterparty} onChange={(e) => set(i, 'counterparty', e.target.value)}><option value="">—</option>{data.partners.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select></td>
            <td>{r.section === 'secondary_royalty' ? <select aria-label="役" value={r.holderRole} onChange={(e) => set(i, 'holderRole', e.target.value)}>{Object.entries(ROLE_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select> : '—'}</td>
            <td><input className="n" aria-label="額" value={r.amount} onChange={(e) => set(i, 'amount', e.target.value)} /></td>
            <td><input aria-label="項目" value={r.item} onChange={(e) => set(i, 'item', e.target.value)} /></td>
            <td><button type="button" onClick={() => setRows((list) => list.filter((_, j) => j !== i))}>外す</button></td>
          </tr>
        ))}</tbody>
      </table>
      <div className="cl-bar">
        <button type="button" onClick={() => setRows((list) => [...list, blankRow()])}>行を足す</button>
        <button type="button" className="pri" onClick={submit} disabled={!closeOn}>台帳に入れる</button>
      </div>
      {result && <div className="cl-alert">{result.text}{result.diff != null ? `（差 ${yen(result.diff)} 円）` : ''}</div>}
    </>
  );
}
