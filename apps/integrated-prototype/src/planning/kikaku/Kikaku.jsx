// 企画の画面（会社ルートの plans/2026-10-22-folder-kikaku.md。問い1〜10 はすべて A）。
// 一覧: 案件ごとに1行（4つのマス 企・試・予・判、good の回収率、段階、担当）。「自分の案件」で今の担当が自分の案件に絞る。
// 1件: まとめ（判定の1行・数字・段階と担当と稟議）／項目（企画の項目と体制の候補の版）／試算（3段: 表紙→流通の大別→流通の詳細、率・出資）／
// 原本（企画書・試算を置く）／準備（企画書の32枚の揃い・素材・事実の下書きと確定）。数字は受け口が計算した値を出すだけ
import React, {useCallback, useEffect, useMemo, useState} from 'react';
import {Notice} from '../../ui/Notice.jsx';
import DocumentPicker from './DocumentPicker.jsx';
import './kikaku.css';

const yen = (v) => (v == null ? '—' : Number(v).toLocaleString('ja-JP'));
const pct = (bps) => (bps == null ? '—' : `${(bps / 100).toFixed(1)}%`);
const SC = [['even', 'even'], ['good', 'good'], ['max', 'MAX']];
const ORIGINS = {source: '原作', cast: 'キャスト', concept: 'コンセプト', sequel: '続編', other: 'その他'};
const ROLES = {director: '監督', writer: '脚本', lead: '主演', support: '助演', producer: 'プロデューサー', studio: '制作会社', other: 'その他'};
const STATUSES = {candidate: '候補', negotiating: '交渉中', confirmed: '確定'};
const KINDS = {similar: '類似作', market: '市場', own_record: '自社の実績', cast: 'キャスト', director: '監督', world: '世界観の文献', story: '物語の構造', title: '題名', report: '申告', other: 'その他'};
const LABELS = {confirmed: '確', probable: '推', unknown: '不明'};
const TARGETS = {deck_text: '企画書の文', trial: '試算の前提', team: '体制の候補', case: '事例'};
const thisMonth = () => new Date().toISOString().slice(0, 7);
const todayIso = () => new Date().toISOString().slice(0, 10);

function readFileBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(',')[1] ?? '');
    reader.onerror = () => reject(reader.error ?? new Error('ファイルを読めません'));
    reader.readAsDataURL(file);
  });
}

function Marks({marks}) {
  return <span className="kk-marks">{marks.map((m) => <span key={m.key} className={`kk-m ${m.done ? 'on' : ''}`} title={m.name}>{m.label}</span>)}</span>;
}

export default function Kikaku({request}) {
  const [list, setList] = useState(null);
  const [me, setMe] = useState(null);
  const [mine, setMine] = useState(false);
  const [projectId, setProjectId] = useState(null);
  const [error, setError] = useState(null);
  const [adding, setAdding] = useState(false);
  const load = useCallback(async () => {
    setError(null);
    try { const r = await request('/planning/kikaku'); setList(r.items); setMe(r.me); } catch (failure) { setError(failure); }
  }, [request]);
  useEffect(() => { load(); }, [load]);
  if (projectId != null) return <KikakuCase request={request} projectId={projectId} onBack={() => { setProjectId(null); load(); }} />;
  const rows = (list ?? []).filter((r) => !mine || r.owner?.userId === me).filter((r) => r.readiness.state !== 'declined' || mine);
  return (
    <section className="kk" data-page="kikaku-list">
      <div className="kk-bar">
        <h2>企画</h2>
        <label className="kk-check"><input type="checkbox" checked={mine} onChange={(e) => setMine(e.target.checked)} /> 自分の案件</label>
        <button type="button" onClick={() => setAdding(!adding)}>＋企画</button>
      </div>
      {error && <Notice error={error} onRetry={load} retryLabel="読み直す" />}
      {adding && <NewProject request={request} onDone={(id) => { setAdding(false); setProjectId(id); }} />}
      {!list ? <p aria-busy="true">読込中…</p> : !rows.length ? <p className="kk-empty">—</p> : (
        <table className="kk-table">
          <thead><tr><th>企画</th><th>揃い</th><th className="n">製作費</th><th className="n">good</th><th>相手の段階</th><th>担当</th><th>予定</th><th></th></tr></thead>
          <tbody>{rows.map((r) => (
            <tr key={r.id} className="kk-row" onClick={() => setProjectId(r.id)} data-project={r.id}>
              <td><b>{r.workingTitle}</b><span className="kk-sub">{r.code}</span></td>
              <td><Marks marks={r.readiness.marks} /></td>
              <td className="n">{yen(r.costTotalYen)}</td>
              <td className="n">{pct(r.recoveryBps)}</td>
              <td>{r.stage?.label ?? '—'}</td>
              <td>{r.owner?.name ?? '—'}</td>
              <td>{r.plannedReleaseYear ?? '未定'}</td>
              <td><span className={`kk-tag ${r.readiness.state}`}>{r.readiness.state === 'done' ? '判断済み' : r.readiness.state === 'declined' ? '見送り' : `残り${r.readiness.missing.length}`}</span></td>
            </tr>))}
          </tbody>
        </table>
      )}
    </section>
  );
}

function NewProject({request, onDone}) {
  const [form, setForm] = useState({code: '', title: '', earningType: 'own_investment', counterpartyName: '', origin: 'concept'});
  const [error, setError] = useState(null);
  const set = (k) => (e) => setForm({...form, [k]: e.target.value});
  const save = async () => {
    setError(null);
    try {
      const r = await request('/planning/kikaku/projects', {method: 'POST', body: {code: form.code, title: form.title, earningType: form.earningType,
        counterpartyName: form.counterpartyName, profile: {origin: form.origin}}});
      onDone(r.id);
    } catch (failure) { setError(failure); }
  };
  return (
    <div className="kk-card kk-form">
      {error && <Notice error={error} />}
      <label>案件コード<input value={form.code} onChange={set('code')} placeholder="KK-2027-01" /></label>
      <label>題名（作業題）<input value={form.title} onChange={set('title')} /></label>
      <label>稼ぎ方<select value={form.earningType} onChange={set('earningType')}><option value="own_investment">自社出資</option><option value="committee">製作委員会</option></select></label>
      <label>起点<select value={form.origin} onChange={set('origin')}>{Object.entries(ORIGINS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></label>
      <label>提出先<input value={form.counterpartyName} onChange={set('counterpartyName')} /></label>
      <button type="button" className="kk-primary" onClick={save}>作る</button>
    </div>
  );
}

function KikakuCase({request, projectId, onBack}) {
  const [data, setData] = useState(null);
  const [tab, setTab] = useState('summary');
  const [error, setError] = useState(null);
  const [message, setMessage] = useState(null);
  const [trialNo, setTrialNo] = useState(null);
  const base = `/planning/kikaku/${projectId}`;
  const load = useCallback(async (no = trialNo) => {
    setError(null);
    try { setData(await request(no ? `${base}?trial=${no}` : base)); } catch (failure) { setError(failure); }
  }, [request, base, trialNo]);
  useEffect(() => { load(); }, [load]);
  const act = async (fn, done) => {
    setError(null); setMessage(null);
    try { await fn(); setMessage(done ?? '✓'); await load(); } catch (failure) { setError(failure); }
  };
  if (!data) return <section className="kk">{error ? <Notice error={error} onRetry={() => load()} retryLabel="読み直す" /> : <p aria-busy="true">読込中…</p>}</section>;
  const tabs = [['summary', 'まとめ'], ['profile', '項目'], ['trial', '試算'], ['docs', '原本'], ['board', '準備']];
  return (
    <section className="kk" data-page="kikaku-case">
      <div className="kk-bar">
        <button type="button" onClick={onBack}>← 一覧</button>
        <h2>{data.profile?.workingTitle ?? data.project.title}<span className="kk-sub">{data.project.code}</span></h2>
        <nav className="kk-tabs">{tabs.map(([k, v]) => <button key={k} type="button" aria-pressed={tab === k} onClick={() => setTab(k)}>{v}</button>)}</nav>
      </div>
      <div className={`kk-verdict ${data.readiness.state}`}><span>{data.readiness.verdict}</span><Marks marks={data.readiness.marks} />{data.readiness.doneOn && <span className="kk-sub">doneOn {data.readiness.doneOn}</span>}</div>
      {error && <Notice error={error} />}
      {message && <p className="kk-message">{message}</p>}
      {tab === 'summary' && <Summary data={data} request={request} base={base} act={act} />}
      {tab === 'profile' && <Profile data={data} request={request} base={base} act={act} />}
      {tab === 'trial' && <Trial data={data} request={request} base={base} act={act} onVersion={(no) => { setTrialNo(no); load(no); }} />}
      {tab === 'docs' && <Docs data={data} request={request} base={base} act={act} />}
      {tab === 'board' && <Board data={data} request={request} base={base} act={act} />}
    </section>
  );
}

function Summary({data, request, base, act}) {
  const t = data.trial?.result.totals;
  const [stage, setStage] = useState('');
  const [stageReason, setStageReason] = useState('');
  const [owner, setOwner] = useState('');
  const [ownerReason, setOwnerReason] = useState('');
  const current = data.stageHistory.at(-1);
  return (
    <>
      <div className="kk-kpis">
        <div className="kk-card"><div className="kk-l">製作費（試算 rev{data.trial?.revision ?? '—'}）</div><div className="kk-big">{yen(data.trial?.input.costTotalYen)}</div></div>
        <div className="kk-card"><div className="kk-l">回収率 good</div><div className="kk-big">{pct(t?.good.recoveryBps)}</div><div className="kk-sub">even {pct(t?.even.recoveryBps)} ／ MAX {pct(t?.max.recoveryBps)}</div></div>
        <div className="kk-card"><div className="kk-l">±0 になる月 good</div><div className="kk-big">{t?.good.breakEvenMonth ?? (t ? '届かない' : '—')}</div></div>
        <div className="kk-card"><div className="kk-l">予算書との差</div><div className="kk-big">{data.budget ? yen(data.budget.diffFromTrialYen) : '—'}</div>{data.budget && <div className="kk-sub">rev{data.budget.versionNo} {yen(data.budget.totalExTaxYen)}</div>}</div>
        <div className="kk-card"><div className="kk-l">作り手への印税 good</div><div className="kk-big">{yen(t?.good.creator)}</div></div>
      </div>
      <div className="kk-two">
        <div className="kk-card">
          <h3>相手の段階</h3>
          <p>{current ? `${current.label}（${current.enteredOn}）` : '—'}</p>
          <div className="kk-inline">
            <select value={stage} onChange={(e) => setStage(e.target.value)}><option value="">段階を選ぶ</option>{data.stages.map((s) => <option key={s.code} value={s.code}>{s.label}</option>)}</select>
            <input placeholder="理由" value={stageReason} onChange={(e) => setStageReason(e.target.value)} />
            <button type="button" disabled={!stage} onClick={() => act(() => request(`${base}/stage`, {method: 'POST', body: {stageCode: stage, previousStageCode: current?.code ?? null, reason: stageReason || null}}), '段階を足しました')}>足す</button>
          </div>
        </div>
        <div className="kk-card">
          <h3>担当</h3>
          <p>{data.owner ? `${data.owner.name}（${data.owner.startedOn} から）` : '—'}</p>
          <div className="kk-inline">
            <select value={owner} onChange={(e) => setOwner(e.target.value)}><option value="">担当を選ぶ</option>{data.members.map((m) => <option key={m.userId} value={m.userId}>{m.name}</option>)}</select>
            <input placeholder="替える理由" value={ownerReason} onChange={(e) => setOwnerReason(e.target.value)} />
            <button type="button" disabled={!owner || !ownerReason} onClick={() => act(() => request(`${base}/owner`, {method: 'POST', body: {userId: Number(owner), reason: ownerReason, expectedRevision: data.ownerRevision}}), '担当を替えました')}>替える</button>
          </div>
        </div>
      </div>
      <div className="kk-card">
        <h3>判断（稟議）</h3>
        {data.approvals.length ? <table className="kk-table"><tbody>{data.approvals.map((a) => <tr key={`${a.approvalNo}-${a.versionNo}`}><td>稟議{a.approvalNo} rev{a.versionNo}</td><td>{a.status}</td><td className="n">{yen(a.amountYen)}</td><td>{a.createdAt?.slice(0, 10)}</td></tr>)}</tbody></table>
          : <p className="kk-empty">—</p>}
      </div>
    </>
  );
}

function Profile({data, request, base, act}) {
  const p = data.profile;
  const [form, setForm] = useState(() => ({workingTitle: p?.workingTitle ?? data.project.title, origin: p?.origin ?? 'concept', logline: p?.logline ?? '', synopsisShort: p?.synopsisShort ?? '',
    synopsisLong: p?.synopsisLong ?? '', format: p?.format ?? '', episodeCount: p?.episodeCount ?? '', plannedReleaseYear: p?.plannedReleaseYear ?? '', submitTo: p?.submitTo ?? data.project.counterpartyName ?? '',
    people: p?.people ?? [], reason: ''}));
  const set = (k) => (e) => setForm({...form, [k]: e.target.value});
  const setPerson = (i, k, v) => setForm({...form, people: form.people.map((x, j) => (j === i ? {...x, [k]: v} : x))});
  const num = (v) => (v === '' || v == null ? null : Number(v));
  return (
    <div className="kk-card kk-form">
      <p className="kk-sub">rev{p?.revision ?? 0}</p>
      <label>作業題<input value={form.workingTitle} onChange={set('workingTitle')} /></label>
      <label>起点<select value={form.origin} onChange={set('origin')}>{Object.entries(ORIGINS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></label>
      <label className="wide">ログライン<textarea rows={2} value={form.logline} onChange={set('logline')} /></label>
      <label className="wide">あらすじ（短）<textarea rows={3} value={form.synopsisShort} onChange={set('synopsisShort')} /></label>
      <label className="wide">あらすじ（長）<textarea rows={5} value={form.synopsisLong} onChange={set('synopsisLong')} /></label>
      <label>形式<input value={form.format} onChange={set('format')} /></label>
      <label>本数<input type="number" min="1" value={form.episodeCount} onChange={set('episodeCount')} /></label>
      <label>予定の公開年<input type="number" value={form.plannedReleaseYear} onChange={set('plannedReleaseYear')} /></label>
      <label>提出先<input value={form.submitTo} onChange={set('submitTo')} /></label>
      <div className="wide">
        <h3>体制の候補</h3>
        {form.people.map((x, i) => (
          <div key={i} className="kk-inline">
            <select value={x.role} onChange={(e) => setPerson(i, 'role', e.target.value)}>{Object.entries(ROLES).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select>
            <input value={x.name} onChange={(e) => setPerson(i, 'name', e.target.value)} placeholder="名前" />
            <select value={x.status} onChange={(e) => setPerson(i, 'status', e.target.value)}>{Object.entries(STATUSES).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select>
            <button type="button" onClick={() => setForm({...form, people: form.people.filter((_, j) => j !== i)})}>×</button>
          </div>
        ))}
        <button type="button" onClick={() => setForm({...form, people: [...form.people, {role: 'director', name: '', status: 'candidate'}]})}>＋人</button>
      </div>
      <label className="wide">版の理由<input value={form.reason} onChange={set('reason')} /></label>
      <button type="button" className="kk-primary" disabled={!form.reason} onClick={() => act(() => request(`${base}/profile`, {method: 'POST', body: {...form, episodeCount: num(form.episodeCount),
        plannedReleaseYear: num(form.plannedReleaseYear), expectedRevision: p?.revision ?? 0}}), '項目の版を足しました')}>版を保存</button>
    </div>
  );
}

function Trial({data, request, base, act, onVersion}) {
  const tr = data.trial;
  const [start, setStart] = useState({costTotalYen: '', firstMonth: thisMonth()});
  const [draft, setDraft] = useState(null);
  const [view, setView] = useState('cover');
  const types = data.trialTypes;
  const typeLabel = (code) => types.find((t) => t.code === code)?.label ?? code;
  if (!tr) {
    return (
      <div className="kk-card kk-form">
        <label>製作費（税抜・円）<input type="number" value={start.costTotalYen} onChange={(e) => setStart({...start, costTotalYen: e.target.value})} /></label>
        <label>起点の月<input type="month" value={start.firstMonth} onChange={(e) => setStart({...start, firstMonth: e.target.value})} /></label>
        <button type="button" className="kk-primary" onClick={() => act(() => request(`${base}/trials`, {method: 'POST', body: {template: true, costTotalYen: Number(start.costTotalYen || 0), firstMonth: start.firstMonth, expectedRevision: 0}}), '型から試算を作りました')}>型から作る</button>
      </div>
    );
  }
  const r = tr.result;
  const edit = () => setDraft(JSON.parse(JSON.stringify({...tr.input, reason: ''})));
  const save = () => act(async () => {
    const body = {...draft, costTotalYen: Number(draft.costTotalYen), lines: draft.lines.map((l) => ({...l, months: Number(l.months), unitPriceYen: Number(l.unitPriceYen || 0),
      evenValue: Number(l.evenValue || 0), goodValue: Number(l.goodValue || 0), maxValue: Number(l.maxValue || 0), previousSalesYen: l.previousSalesYen === '' || l.previousSalesYen == null ? null : Number(l.previousSalesYen)})),
      rates: draft.rates.map((x) => ({...x, shareBps: Number(x.shareBps), feeBps: Number(x.feeBps), originalBps: Number(x.originalBps), creatorBps: Number(x.creatorBps), unitCostYen: Number(x.unitCostYen)})),
      investments: draft.investments.map((i) => ({...i, amountYen: Number(i.amountYen)})), expectedRevision: data.trialVersions.at(-1)?.revision ?? 0};
    await request(`${base}/trials`, {method: 'POST', body});
    setDraft(null);
  }, '試算の版を足しました');
  const setLine = (i, k, v) => setDraft({...draft, lines: draft.lines.map((x, j) => (j === i ? {...x, [k]: v} : x))});
  const setRate = (i, k, v) => setDraft({...draft, rates: draft.rates.map((x, j) => (j === i ? {...x, [k]: v} : x))});
  const setInv = (i, k, v) => setDraft({...draft, investments: draft.investments.map((x, j) => (j === i ? {...x, [k]: v} : x))});
  return (
    <>
      <div className="kk-inline kk-versions">
        <span>版</span>
        <select value={tr.revision} onChange={(e) => onVersion(Number(e.target.value))}>{data.trialVersions.map((v) => <option key={v.revision} value={v.revision}>rev{v.revision} good {pct(v.recovery.good)}（{v.reason}）</option>)}</select>
        <span className="kk-axis">{[['cover', '表紙'], ['groups', '流通の大別'], ['detail', '流通の詳細'], ['schedule', '回収スケジュール']].map(([k, v]) => <button key={k} type="button" aria-pressed={view === k} onClick={() => setView(k)}>{v}</button>)}</span>
        {!draft && <button type="button" onClick={edit}>直して版にする</button>}
      </div>
      {!draft && view === 'cover' && (
        <div className="kk-card"><table className="kk-table">
          <thead><tr><th>流通の大別</th>{SC.map(([k, v]) => <th key={k} className="n">{v}</th>)}<th className="n">前作実績（売上）</th></tr></thead>
          <tbody>
            {r.groups.map((g) => <tr key={g.group}><td>{g.group}</td>{SC.map(([k]) => <td key={k} className="n">{yen(g[k].income)}</td>)}<td className="n">{yen(g.previousSalesYen)}</td></tr>)}
            <tr className="kk-total"><td>権利元収入の合計</td>{SC.map(([k]) => <td key={k} className="n">{yen(r.totals[k].income)}</td>)}<td /></tr>
            <tr><td>製作費</td>{SC.map(([k]) => <td key={k} className="n">{yen(tr.input.costTotalYen)}</td>)}<td /></tr>
            <tr><td>損益</td>{SC.map(([k]) => <td key={k} className={`n ${r.totals[k].profit < 0 ? 'bad' : ''}`}>{yen(r.totals[k].profit)}</td>)}<td /></tr>
            <tr className="kk-total"><td>回収率</td>{SC.map(([k]) => <td key={k} className="n">{pct(r.totals[k].recoveryBps)}</td>)}<td /></tr>
            <tr><td>±0 になる月</td>{SC.map(([k]) => <td key={k} className="n">{r.totals[k].breakEvenMonth ?? '届かない'}</td>)}<td /></tr>
            <tr><td>作り手への印税</td>{SC.map(([k]) => <td key={k} className="n">{yen(r.totals[k].creator)}</td>)}<td /></tr>
          </tbody></table></div>
      )}
      {!draft && view === 'groups' && (
        <div className="kk-card kk-scroll"><table className="kk-table">
          <thead><tr><th>流通の大別</th>{SC.map(([k, v]) => <React.Fragment key={k}><th className="n">売上 {v}</th><th className="n">控除</th><th className="n">作り手への印税</th><th className="n">権利元収入</th></React.Fragment>)}<th className="n">行</th></tr></thead>
          <tbody>{r.groups.map((g) => <tr key={g.group}><td>{g.group}</td>{SC.map(([k]) => <React.Fragment key={k}><td className="n">{yen(g[k].sale)}</td><td className="n">{yen(g[k].deduction)}</td><td className="n">{yen(g[k].creator)}</td><td className="n"><b>{yen(g[k].income)}</b></td></React.Fragment>)}<td className="n">{g.lines}</td></tr>)}</tbody>
        </table></div>
      )}
      {!draft && view === 'detail' && (
        <div className="kk-card kk-scroll"><table className="kk-table">
          <thead><tr><th>#</th><th>販売の型</th><th>取引先</th><th>窓口</th><th>開始</th><th className="n">月数</th><th>計算</th><th className="n">単価</th>{SC.map(([k, v]) => <th key={k} className="n">数量か額 {v}</th>)}{SC.map(([k, v]) => <th key={`i${k}`} className="n">権利元収入 {v}</th>)}<th>出典</th></tr></thead>
          <tbody>{r.rows.map((l) => <tr key={l.lineNo}><td>{l.lineNo}</td><td>{typeLabel(l.typeCode)}</td><td>{l.partnerName}</td><td>{l.windowLabel}</td><td>{l.startMonth}</td><td className="n">{l.months}</td><td>{l.calc === 'fixed' ? '固定額' : '単価×数量'}</td><td className="n">{l.calc === 'fixed' ? '—' : yen(l.unitPriceYen)}</td>{SC.map(([k]) => <td key={k} className="n">{yen(l[`${k}Value`])}</td>)}{SC.map(([k]) => <td key={`i${k}`} className="n">{yen(l.result[k].income)}</td>)}<td>{l.source}</td></tr>)}</tbody>
        </table></div>
      )}
      {!draft && view === 'schedule' && (
        <div className="kk-card kk-scroll"><table className="kk-table">
          <thead><tr><th>月</th>{SC.map(([k, v]) => <React.Fragment key={k}><th className="n">入金 {v}</th><th className="n">累計 {v}</th></React.Fragment>)}<th className="n">出資</th></tr></thead>
          <tbody>{r.months.map((m, i) => <tr key={m}><td>{m}</td>{SC.map(([k]) => { const s = r.totals[k].schedule[i]; return <React.Fragment key={k}><td className="n">{yen(s.inflow)}</td><td className={`n ${s.cumulative < 0 ? 'bad' : ''}`}>{yen(s.cumulative)}</td></React.Fragment>; })}<td className="n">{yen(r.totals.good.schedule[i].outflow)}</td></tr>)}</tbody>
        </table></div>
      )}
      {draft && (
        <div className="kk-card kk-editor">
          <div className="kk-inline">
            <label>製作費<input type="number" value={draft.costTotalYen} onChange={(e) => setDraft({...draft, costTotalYen: e.target.value})} /></label>
            <label>起点の月<input type="month" value={draft.firstMonth} onChange={(e) => setDraft({...draft, firstMonth: e.target.value})} /></label>
          </div>
          <h3>流通の詳細</h3>
          <div className="kk-scroll"><table className="kk-table kk-grid">
            <thead><tr><th>販売の型</th><th>取引先</th><th>窓口</th><th>開始月</th><th>月数</th><th>計算</th><th>単価</th>{SC.map(([k, v]) => <th key={k}>{v}</th>)}<th>出典</th><th>前作実績</th><th /></tr></thead>
            <tbody>{draft.lines.map((l, i) => <tr key={i}>
              <td><select value={l.typeCode} onChange={(e) => setLine(i, 'typeCode', e.target.value)}>{types.map((t) => <option key={t.code} value={t.code}>{t.label}</option>)}</select></td>
              <td><input value={l.partnerName} onChange={(e) => setLine(i, 'partnerName', e.target.value)} /></td>
              <td><input className="s" value={l.windowLabel ?? ''} onChange={(e) => setLine(i, 'windowLabel', e.target.value)} /></td>
              <td><input type="month" value={l.startMonth} onChange={(e) => setLine(i, 'startMonth', e.target.value)} /></td>
              <td><input className="xs" type="number" min="1" value={l.months} onChange={(e) => setLine(i, 'months', e.target.value)} /></td>
              <td><select value={l.calc} onChange={(e) => setLine(i, 'calc', e.target.value)}><option value="unit">単価×数量</option><option value="fixed">固定額</option></select></td>
              <td><input className="n s" type="number" value={l.calc === 'fixed' ? 0 : l.unitPriceYen} disabled={l.calc === 'fixed'} onChange={(e) => setLine(i, 'unitPriceYen', e.target.value)} /></td>
              {SC.map(([k]) => <td key={k}><input className="n" type="number" value={l[`${k}Value`]} onChange={(e) => setLine(i, `${k}Value`, e.target.value)} /></td>)}
              <td><input className="s" value={l.source ?? ''} onChange={(e) => setLine(i, 'source', e.target.value)} /></td>
              <td><input className="n" type="number" value={l.previousSalesYen ?? ''} onChange={(e) => setLine(i, 'previousSalesYen', e.target.value)} /></td>
              <td><button type="button" onClick={() => setDraft({...draft, lines: draft.lines.filter((_, j) => j !== i)})}>×</button></td>
            </tr>)}</tbody>
          </table></div>
          <button type="button" onClick={() => setDraft({...draft, lines: [...draft.lines, {typeCode: 'TVOD', partnerName: '', windowLabel: '', startMonth: draft.firstMonth, months: 12, calc: 'unit', unitPriceYen: 500, evenValue: 0, goodValue: 0, maxValue: 0, source: '自社想定', previousSalesYen: null}]})}>＋行</button>
          <h3>前提（bp）</h3>
          <div className="kk-scroll"><table className="kk-table kk-grid">
            <thead><tr><th>販売の型</th><th>先方の取り分</th><th>手数料</th><th>原作の印税</th><th>監督・脚本の印税</th><th>製造単価</th><th>出典</th></tr></thead>
            <tbody>{draft.rates.map((x, i) => <tr key={x.typeCode}><td>{typeLabel(x.typeCode)}</td>
              {['shareBps', 'feeBps', 'originalBps', 'creatorBps', 'unitCostYen'].map((k) => <td key={k}><input className="n s" type="number" value={x[k]} onChange={(e) => setRate(i, k, e.target.value)} /></td>)}
              <td><input className="s" value={x.source ?? ''} onChange={(e) => setRate(i, 'source', e.target.value)} /></td></tr>)}</tbody>
          </table></div>
          <h3>出資</h3>
          {draft.investments.map((v, i) => <div key={i} className="kk-inline"><input type="month" value={v.month} onChange={(e) => setInv(i, 'month', e.target.value)} /><input className="n" type="number" value={v.amountYen} onChange={(e) => setInv(i, 'amountYen', e.target.value)} /><button type="button" onClick={() => setDraft({...draft, investments: draft.investments.filter((_, j) => j !== i)})}>×</button></div>)}
          <button type="button" onClick={() => setDraft({...draft, investments: [...draft.investments, {month: draft.firstMonth, amountYen: 0}]})}>＋出資</button>
          <div className="kk-inline"><input className="wide" placeholder="版の理由" value={draft.reason} onChange={(e) => setDraft({...draft, reason: e.target.value})} />
            <button type="button" className="kk-primary" disabled={!draft.reason} onClick={save}>版を保存</button><button type="button" onClick={() => setDraft(null)}>やめる</button></div>
        </div>
      )}
    </>
  );
}

function Docs({data, request, base, act}) {
  const [picker, setPicker] = useState(null);
  const [deck, setDeck] = useState({role: 'draft', submittedTo: data.project.counterpartyName ?? '', submittedOn: todayIso()});
  const upload = (kind, file, extra = {}) => act(async () => {
    await request(`${base}/documents`, {method: 'POST', body: {kind, fileName: file.name, mediaType: file.type, base64: await readFileBase64(file), ...extra}});
  }, `${file.name} を置きました`);
  const download = async (d) => {
    const r = await request(`${base}/documents/${d.documentId}`);
    const a = document.createElement('a');
    a.href = `data:${r.mediaType || 'application/octet-stream'};base64,${r.base64}`;
    a.download = r.fileName; a.click();
  };
  const list = (kind) => data.documents.filter((d) => d.kind === kind);
  const choose = (kind) => picker === kind && <DocumentPicker key={kind} request={request} base={base} kind={kind} extra={kind === 'deck' ? deck : {}}
    onClose={() => setPicker(null)} onLinked={() => { setPicker(null); act(async () => {}, '結び付けました'); }} />;
  const file = (d) => d.storage === 'external' ? <span title={d.externalLocation}>{d.fileName}</span>
    : <button type="button" className="kk-link" onClick={() => act(() => download(d))}>{d.fileName}</button>;
  return (
    <div className="kk-two">
      <div className="kk-card">
        <h3>企画書</h3>
        <div className="kk-inline">
          <select value={deck.role} onChange={(e) => setDeck({...deck, role: e.target.value})}><option value="draft">下書き</option><option value="submitted">提出版</option></select>
          {deck.role === 'submitted' && <><input placeholder="提出先" value={deck.submittedTo} onChange={(e) => setDeck({...deck, submittedTo: e.target.value})} /><input type="date" value={deck.submittedOn} onChange={(e) => setDeck({...deck, submittedOn: e.target.value})} /></>}
        </div>
        <div className="kk-inline"><label className="kk-drop">＋企画書<input type="file" hidden accept=".pptx,.pdf,.key,.docx" onChange={(e) => e.target.files[0] && upload('deck', e.target.files[0], deck)} /></label>
          <button type="button" aria-label="企画書を置き場から選ぶ" aria-expanded={picker === 'deck'} onClick={() => setPicker(picker === 'deck' ? null : 'deck')}>置き場</button></div>
        {choose('deck')}
        {list('deck').map((d) => <p key={d.id} className="kk-file">{file(d)}<span className={`kk-tag ${d.role === 'submitted' ? 'done' : ''}`}>{d.role === 'submitted' ? `提出版 ${d.submittedOn} ${d.submittedTo ?? ''}` : '下書き'}</span></p>)}
      </div>
      <div className="kk-card">
        <h3>売上試算</h3>
        <div className="kk-inline"><label className="kk-drop">＋試算<input type="file" hidden accept=".xlsx,.xls,.pdf" onChange={(e) => e.target.files[0] && upload('trial', e.target.files[0])} /></label>
          <button type="button" aria-label="試算を置き場から選ぶ" aria-expanded={picker === 'trial'} onClick={() => setPicker(picker === 'trial' ? null : 'trial')}>置き場</button></div>
        {choose('trial')}
        {list('trial').map((d) => <p key={d.id} className="kk-file">{file(d)}<span className="kk-sub">{d.createdAt?.slice(0, 10)}</span></p>)}
      </div>
    </div>
  );
}

function Board({data, request, base, act}) {
  const [sel, setSel] = useState(27);
  const [mat, setMat] = useState({kind: 'similar', title: '', label: 'confirmed', source: '', url: ''});
  const [fact, setFact] = useState({body: '', label: 'confirmed', target: 'deck_text', pages: '', materialId: ''});
  const b = data.board;
  const page = b.pages.find((p) => p.no === sel);
  const facts = data.facts.filter((f) => b.pages.find((p) => p.no === sel)?.facts.includes(f.id));
  const chapters = useMemo(() => [...new Set(b.pages.map((p) => p.chapter))], [b]);
  const chapterName = {'': '表紙・目次', '序': '序 王道の型', '01': '01 作り方・実績・市場・流通', '02': '02 シリーズ', '03': '03 役者', '04': '04 作品', '05': '05 体制', '06': '06 回収設計'};
  const matName = (id) => data.materials.find((m) => m.id === id)?.title ?? '—';
  const addMaterial = async (file) => act(async () => {
    const extra = file ? {fileName: file.name, mediaType: file.type, base64: await readFileBase64(file)} : {};
    await request(`${base}/materials`, {method: 'POST', body: {...mat, url: mat.url || null, ...extra}});
    setMat({...mat, title: '', source: '', url: ''});
  }, '素材を足しました');
  return (
    <>
      <div className="kk-flow">
        <div><b>{b.counts.materials}</b>① 素材</div><div><b>{b.counts.drafts}</b>② 下書き</div><div><b>{b.counts.confirmed}</b>③ 確定</div><div><b>{b.ready}/32</b>④ ページ</div>
        <div className="bad"><b>{b.gaps}</b>足りないページ</div>
      </div>
      <div className="kk-two">
        <div className="kk-card">
          {chapters.map((ch) => <div key={ch} className="kk-sec"><div className="kk-sub">{chapterName[ch]}</div><div className="kk-tiles">
            {b.pages.filter((p) => p.chapter === ch).map((p) => <button key={p.no} type="button" className={`kk-tile ${p.state} ${p.gap ? 'gap' : ''} ${p.no === sel ? 'sel' : ''}`} onClick={() => setSel(p.no)}>
              <span className="no">{String(p.no).padStart(2, '0')}</span><span className="lb">{p.theme}</span><span className="dots">{p.state === 'auto' ? '自動' : p.need === 'trial' ? '試算から' : p.total ? `事実 ${p.confirmed}/${p.total}` : '—'}</span></button>)}
          </div></div>)}
        </div>
        <div className="kk-card">
          <h3>{String(page.no).padStart(2, '0')} {page.theme}</h3>
          <p className="kk-sub">{page.need === 'auto' ? '自動' : page.need === 'trial' ? '試算' : page.need}</p>
          {facts.length ? facts.map((f) => <div key={f.id} className={`kk-fact ${f.state}`}><span className={`kk-lab ${f.label}`}>{LABELS[f.label]}</span>{f.body}
            <span className="kk-sub">{TARGETS[f.target]}・素材 {f.materialId ? matName(f.materialId) : '—'}・p{f.pages}</span>
            {f.state === 'ai_draft' ? <button type="button" onClick={() => act(() => request(`${base}/facts/${f.id}/confirm`, {method: 'POST', body: {}}), '確定しました')}>確定</button> : <span className="kk-tag done">確定</span>}</div>)
            : <p className="kk-empty">—</p>}
        </div>
      </div>
      <div className="kk-two">
        <div className="kk-card kk-form">
          <h3 className="wide">素材</h3>
          <label>種類<select value={mat.kind} onChange={(e) => setMat({...mat, kind: e.target.value})}>{Object.entries(KINDS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></label>
          <label>判定<select value={mat.label} onChange={(e) => setMat({...mat, label: e.target.value})}>{Object.entries(LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></label>
          <label className="wide">名前<input value={mat.title} onChange={(e) => setMat({...mat, title: e.target.value})} /></label>
          <label className="wide">出典<input value={mat.source} onChange={(e) => setMat({...mat, source: e.target.value})} /></label>
          <label className="wide">URL<input value={mat.url} onChange={(e) => setMat({...mat, url: e.target.value})} /></label>
          <div className="wide kk-inline"><button type="button" className="kk-primary" disabled={!mat.title} onClick={() => addMaterial(null)}>足す</button>
            <label className="kk-drop">＋ファイル<input type="file" hidden onChange={(e) => e.target.files[0] && mat.title && addMaterial(e.target.files[0])} /></label></div>
          <div className="wide">{data.materials.map((m) => <p key={m.id} className="kk-file"><span className="kk-tag">{KINDS[m.kind]}</span>{m.title}<span className={`kk-lab ${m.label}`}>{LABELS[m.label]}</span>{m.fileName && <span className="kk-sub">{m.fileName}</span>}</p>)}</div>
        </div>
        <div className="kk-card kk-form">
          <h3 className="wide">事実</h3>
          <label className="wide">事実<textarea rows={3} value={fact.body} onChange={(e) => setFact({...fact, body: e.target.value})} /></label>
          <label>判定<select value={fact.label} onChange={(e) => setFact({...fact, label: e.target.value})}>{Object.entries(LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></label>
          <label>入る先<select value={fact.target} onChange={(e) => setFact({...fact, target: e.target.value})}>{Object.entries(TARGETS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></label>
          <label>結ぶページ<input value={fact.pages || String(sel)} onChange={(e) => setFact({...fact, pages: e.target.value})} placeholder="3,12" /></label>
          <label>素材<select value={fact.materialId} onChange={(e) => setFact({...fact, materialId: e.target.value})}><option value="">—</option>{data.materials.map((m) => <option key={m.id} value={m.id}>{m.title}</option>)}</select></label>
          <button type="button" className="kk-primary" disabled={!fact.body} onClick={() => act(async () => {
            await request(`${base}/facts`, {method: 'POST', body: {...fact, pages: String(fact.pages || sel).split(',').map((v) => Number(v.trim())).filter(Boolean), materialId: fact.materialId || null}});
            setFact({...fact, body: ''});
          }, '事実を下書きで足しました')}>下書きで足す</button>
        </div>
      </div>
    </>
  );
}
