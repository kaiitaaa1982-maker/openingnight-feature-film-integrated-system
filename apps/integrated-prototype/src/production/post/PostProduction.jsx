// ポストプロダクションの画面（要件 docs/requirements/production/post-production.md。会社ルートの計画 plans/2026-10-22-folder-postprod.md の第3版）。
// 作品の一覧（数字だけ）→ 1作品: ホーム（数字と工程のカード）・工程（タスクの済・未）・動画とメモ（止めた TC に構造化されたメモ）・納品物（契約の物件の ✓）。
// 値は受け口から読むだけ。数字・状態は受け口が足した行から導いた値
import React, {useCallback, useEffect, useRef, useState} from 'react';
import {Notice} from '../../ui/Notice.jsx';
import './post.css';

const VIMEO_ORIGIN = 'https://player.vimeo.com';
const STATUS_TONE = {delivered: 'ok', in_review: 'warn', making: 'warn', redo: 'bad', pending: ''};
const NOTE_TONE = {open: 'bad', hold: 'warn', fixed: 'ok', skipped: ''};
const NOTE_LABEL = {open: '未', hold: '保留', fixed: '直した', skipped: '見送り'};
const FOLDER_LABEL = {not_started: '未着手', in_progress: '進行中', needs_review: '要確認', done: '済み'};

function tc(seconds) {
  if (seconds == null) return '';
  const s = Math.max(0, Math.floor(Number(seconds)));
  return [Math.floor(s / 3600), Math.floor((s % 3600) / 60), s % 60].map((n) => String(n).padStart(2, '0')).join(':');
}
const md = (date) => (date ? date.slice(5).replace('-', '/') : '');

function Big({items}) {
  return (
    <div className="pp-big">
      {items.map(([value, label, tone]) => <div key={label} className={tone ?? ''}><b>{value}</b><span>{label}</span></div>)}
    </div>
  );
}

export default function PostProduction({request}) {
  const [list, setList] = useState(null);
  const [workId, setWorkId] = useState(null);
  const [error, setError] = useState(null);
  const load = useCallback(async () => {
    setError(null);
    try { setList(await request('/post/works')); } catch (failure) { setError(failure); }
  }, [request]);
  useEffect(() => { load(); }, [load]);
  if (workId != null) return <PostWork request={request} workId={workId} onBack={() => { setWorkId(null); load(); }} />;
  return (
    <section className="pp" data-page="post-list">
      {error && <Notice error={error} onRetry={load} retryLabel="読み直す" />}
      {!list ? <p aria-busy="true">読込中…</p> : !list.works.length ? <p className="pp-mute">—</p> : (
        <div className="pp-works">
          {list.works.map((w) => (
            <button key={w.workId} type="button" className={`pp-work ${w.folderStatus.state}`} onClick={() => setWorkId(w.workId)} data-work={w.workId}>
              <span className="pp-work-title">{w.title}<small>{w.code}</small></span>
              <span className="pp-work-nums">
                <span className="ok">{w.numbers.delivered}<small>納品済</small></span>
                <span>{w.numbers.total - w.numbers.delivered}<small>残り</small></span>
                <span className={w.numbers.lateTasks ? 'bad' : ''}>{w.numbers.lateTasks}<small>期限超</small></span>
                <span className={w.numbers.openNotes ? 'warn' : ''}>{w.numbers.openNotes}<small>指示の残り</small></span>
              </span>
              <span className={`pp-tag ${w.folderStatus.state}`}>{FOLDER_LABEL[w.folderStatus.state]}</span>
            </button>
          ))}
        </div>
      )}
    </section>
  );
}

function PostWork({request, workId, onBack}) {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [tab, setTab] = useState('home');
  const [phase, setPhase] = useState('edit');
  const [busy, setBusy] = useState(false);
  const base = `/post/works/${workId}`;
  const load = useCallback(async () => {
    setError(null);
    try { setData(await request(base)); } catch (failure) { setError(failure); }
  }, [request, base]);
  useEffect(() => { load(); }, [load]);
  const act = useCallback(async (fn) => {
    setBusy(true); setError(null);
    try { await fn(); await load(); return true; } catch (failure) { setError(failure); return false; } finally { setBusy(false); }
  }, [load]);
  const post = useCallback((path, body) => request(`${base}${path}`, {method: 'POST', body}), [request, base]);
  if (!data) return <section className="pp">{error ? <Notice error={error} onRetry={load} retryLabel="読み直す" /> : <p aria-busy="true">読込中…</p>}</section>;
  const tabs = [['home', 'ホーム'], ['phase', '工程'], ['review', '動画とメモ'], ['deliverables', '納品物']];
  return (
    <section className="pp" data-page="post-work" aria-busy={busy}>
      <div className="pp-head"><button type="button" onClick={onBack}>← 作品の一覧</button><h2>{data.work.title}<small>{data.work.code}</small></h2></div>
      <div className="pp-tabs" role="tablist">
        {tabs.map(([id, label]) => <button key={id} type="button" role="tab" aria-selected={tab === id} onClick={() => setTab(id)}>{label}</button>)}
      </div>
      {error && <Notice error={error} onRetry={load} retryLabel="読み直す" />}
      {tab === 'home' && <Home data={data} onPhase={(p) => { if (p === 'delivery') setTab('deliverables'); else { setPhase(p); setTab('phase'); } }} />}
      {tab === 'phase' && <Phase data={data} phase={phase} setPhase={setPhase} act={act} post={post} />}
      {tab === 'review' && <Review data={data} act={act} post={post} />}
      {tab === 'deliverables' && <Deliverables data={data} act={act} post={post} />}
    </section>
  );
}

function Home({data, onPhase}) {
  const n = data.numbers;
  return (
    <div>
      <p className="pp-label">納品物 {n.total}</p>
      <Big items={[[n.delivered, '納品済み', 'ok'], [n.inReview, '確認中', 'warn'], [n.pending, '未'], [n.lateTasks, '期限超', n.lateTasks ? 'bad' : '']]} />
      <p className="pp-label">工程</p>
      <div className="pp-cards">
        {data.phases.map((p) => {
          const pct = p.total ? Math.round((p.done / p.total) * 100) : 0;
          return (
            <button key={p.phase} type="button" className={`pp-card ${p.total && p.done === p.total ? 'done' : ''} ${p.late ? 'late' : ''}`} onClick={() => onPhase(p.phase)}>
              <span className="pp-card-name">{p.label}</span>
              <span className="pp-card-num">{p.done}<small> / {p.total}</small></span>
              <span className="pp-bar"><i style={{width: `${pct}%`}} /></span>
              <span className="pp-card-goal">{p.late ? `期限超 ${p.late}` : p.goal ? `ゴール ${md(p.goal)}` : ''}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

function Phase({data, phase, setPhase, act, post}) {
  const tasks = data.tasks.filter((t) => t.phase === phase);
  const done = tasks.filter((t) => t.done).length;
  const late = tasks.filter((t) => !t.done && t.dueOn && t.dueOn < data.today).length;
  const [form, setForm] = useState({name: '', episodeNo: '', dueOn: '', assignee: ''});
  const phases = data.vocabulary.phases.filter((p) => p.code !== 'delivery');
  return (
    <div>
      <div className="pp-chips">{phases.map((p) => <button key={p.code} type="button" aria-pressed={p.code === phase} onClick={() => setPhase(p.code)}>{p.label}</button>)}</div>
      <Big items={[[done, '済み', 'ok'], [tasks.length - done, '残り'], [late, '期限超', late ? 'bad' : '']]} />
      <table className="pp-table">
        <thead><tr><th /><th>話</th><th>タスク</th><th>担当</th><th>期日</th><th>済んだ日</th></tr></thead>
        <tbody>
          {tasks.map((t) => (
            <tr key={t.id} className={t.done ? 'mute' : ''}>
              <td><button type="button" className={`pp-check ${t.done ? 'on' : ''}`} aria-label={t.done ? '未に戻す' : '済みにする'}
                onClick={() => act(() => post(`/tasks/${t.id}/events`, {kind: t.done ? 'undone' : 'done'}))}>{t.done ? '●' : '○'}</button></td>
              <td>{t.episodeNo ?? ''}</td><td>{t.name}</td><td>{t.assignee ?? ''}</td>
              <td className={!t.done && t.dueOn && t.dueOn < data.today ? 'bad' : ''}>
                <input type="date" value={t.dueOn ?? ''} onChange={(e) => e.target.value && act(() => post(`/tasks/${t.id}/events`, {kind: 'due', dueOn: e.target.value}))} />
              </td>
              <td>{md(t.doneOn) || '—'}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <form className="pp-form" onSubmit={async (e) => { e.preventDefault(); if (await act(() => post('/tasks', {...form, phase}))) setForm({name: '', episodeNo: form.episodeNo, dueOn: '', assignee: form.assignee}); }}>
        <input placeholder="タスク" value={form.name} onChange={(e) => setForm({...form, name: e.target.value})} required />
        <input className="s" placeholder="話" inputMode="numeric" value={form.episodeNo} onChange={(e) => setForm({...form, episodeNo: e.target.value})} />
        <input className="m" placeholder="担当" value={form.assignee} onChange={(e) => setForm({...form, assignee: e.target.value})} />
        <input type="date" value={form.dueOn} onChange={(e) => setForm({...form, dueOn: e.target.value})} />
        <button type="submit">足す</button>
      </form>
    </div>
  );
}

function Review({data, act, post}) {
  const [cutId, setCutId] = useState(data.cuts.at(-1)?.id ?? null);
  const cut = data.cuts.find((c) => c.id === cutId) ?? null;
  const frame = useRef(null);
  const pending = useRef(null);
  const v = data.vocabulary;
  const [note, setNote] = useState({tcIn: '', tcOut: '', viewpoint: v.viewpoints[0], fromRole: v.fromRoles[0], assignee: v.assignees[0], body: ''});
  const [cutForm, setCutForm] = useState(null);
  useEffect(() => {
    function onMessage(event) {
      if (event.origin !== VIMEO_ORIGIN) return;
      let message;
      try { message = typeof event.data === 'string' ? JSON.parse(event.data) : event.data; } catch { return; }
      if (message?.method === 'getCurrentTime' && pending.current) { pending.current(Number(message.value)); pending.current = null; }
    }
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, []);
  const send = (method, value) => frame.current?.contentWindow?.postMessage(JSON.stringify(value == null ? {method} : {method, value}), VIMEO_ORIGIN);
  const grab = () => { if (!cut?.embedUrl) return; send('pause'); pending.current = (s) => setNote((n) => ({...n, tcIn: tc(s)})); send('getCurrentTime'); };
  const seek = (seconds) => { if (cut?.embedUrl) send('setCurrentTime', seconds); };
  const notes = data.notes.filter((n) => n.cutId === cutId).sort((a, b) => a.tcIn - b.tcIn);
  const open = notes.filter((n) => n.state === 'open' || n.state === 'hold').length;
  const answer = (n, result) => {
    let reason = null;
    if (result === 'skipped') { reason = window.prompt('見送る理由'); if (!reason) return; }
    act(() => post(`/notes/${n.id}/actions`, {result, reason, fixedCutId: result === 'fixed' ? data.cuts.at(-1)?.id ?? null : null}));
  };
  return (
    <div>
      <div className="pp-chips">
        {data.cuts.map((c) => <button key={c.id} type="button" aria-pressed={c.id === cutId} onClick={() => setCutId(c.id)}>
          {c.episodeNo ? `第${c.episodeNo}話 ` : ''}{c.variant ? `${c.variant} ` : ''}{c.label}{c.kind !== 'work' ? `（${v.cutKinds[c.kind]}）` : ''}</button>)}
        <button type="button" onClick={() => setCutForm({label: '', kind: 'work', episodeNo: '', variant: '', deliveredOn: data.today, runtime: '', reviewUrl: ''})}>＋ 版を足す</button>
      </div>
      {cutForm && (
        <form className="pp-form" onSubmit={async (e) => { e.preventDefault(); if (await act(() => post('/cuts', cutForm))) setCutForm(null); }}>
          <input className="m" placeholder="版" value={cutForm.label} onChange={(e) => setCutForm({...cutForm, label: e.target.value})} required />
          <select value={cutForm.kind} onChange={(e) => setCutForm({...cutForm, kind: e.target.value})}>{Object.entries(v.cutKinds).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select>
          <input className="s" placeholder="話" value={cutForm.episodeNo} onChange={(e) => setCutForm({...cutForm, episodeNo: e.target.value})} />
          <input className="m" placeholder="出し先の版" value={cutForm.variant} onChange={(e) => setCutForm({...cutForm, variant: e.target.value})} />
          <input type="date" value={cutForm.deliveredOn} onChange={(e) => setCutForm({...cutForm, deliveredOn: e.target.value})} />
          <input className="m" placeholder="尺" value={cutForm.runtime} onChange={(e) => setCutForm({...cutForm, runtime: e.target.value})} />
          <input className="l" placeholder="Vimeo" value={cutForm.reviewUrl} onChange={(e) => setCutForm({...cutForm, reviewUrl: e.target.value})} />
          <button type="submit">足す</button><button type="button" onClick={() => setCutForm(null)}>やめる</button>
        </form>
      )}
      {!cut ? null : (
        <div className="pp-review">
          <div className="pp-player">
            {cut.embedUrl
              ? <iframe ref={frame} src={cut.embedUrl} title={`${cut.label} の動画`} allow="autoplay; fullscreen; picture-in-picture" allowFullScreen />
              : <div className="pp-noplayer">{cut.reviewUrl ? <a href={cut.reviewUrl} target="_blank" rel="noreferrer noopener">リンクを別の窓で開く</a> : '—'}</div>}
          </div>
          <form className="pp-note" onSubmit={async (e) => { e.preventDefault(); if (await act(() => post('/notes', {...note, cutId}))) setNote({...note, tcIn: '', tcOut: '', body: ''}); }}>
            <div className="pp-row">
              <button type="button" className="pp-grab" onClick={grab} disabled={!cut.embedUrl}>⏸ 止めて TC</button>
              <input className="tc" placeholder="00:00:00" value={note.tcIn} onChange={(e) => setNote({...note, tcIn: e.target.value})} required />
              <input className="tc" placeholder="アウト" value={note.tcOut} onChange={(e) => setNote({...note, tcOut: e.target.value})} />
            </div>
            <div className="pp-row">
              <select aria-label="観点" value={note.viewpoint} onChange={(e) => setNote({...note, viewpoint: e.target.value})}>{v.viewpoints.map((x) => <option key={x}>{x}</option>)}</select>
              <select aria-label="誰から" value={note.fromRole} onChange={(e) => setNote({...note, fromRole: e.target.value})}>{v.fromRoles.map((x) => <option key={x}>{x}</option>)}</select>
              <select aria-label="担当" value={note.assignee} onChange={(e) => setNote({...note, assignee: e.target.value})}>{v.assignees.map((x) => <option key={x}>{x}</option>)}</select>
            </div>
            <textarea placeholder="指示" value={note.body} onChange={(e) => setNote({...note, body: e.target.value})} required />
            <button type="submit">この TC にメモを残す</button>
          </form>
        </div>
      )}
      {cut && (
        <>
          <p className="pp-label">残り {open} / {notes.length}</p>
          <table className="pp-table">
            <thead><tr><th>TC</th><th>観点</th><th>誰から</th><th>担当</th><th>指示</th><th>状態</th><th /></tr></thead>
            <tbody>
              {notes.map((n) => (
                <tr key={n.id} className={n.state === 'fixed' || n.state === 'skipped' ? 'mute' : ''}>
                  <td><button type="button" className="pp-tc" onClick={() => seek(n.tcIn)}>{tc(n.tcIn)}{n.tcOut != null ? `–${tc(n.tcOut)}` : ''}</button></td>
                  <td>{n.viewpoint}</td><td>{n.fromRole}</td><td>{n.assignee}</td><td className="wrap">{n.body}</td>
                  <td><span className={`pp-tag ${NOTE_TONE[n.state]}`}>{NOTE_LABEL[n.state]}</span></td>
                  <td className="pp-acts">
                    {n.state === 'fixed' || n.state === 'skipped'
                      ? <button type="button" onClick={() => answer(n, 'reopen')}>戻す</button>
                      : <><button type="button" onClick={() => answer(n, 'fixed')}>直した</button><button type="button" onClick={() => answer(n, 'hold')}>保留</button>
                        <button type="button" onClick={() => answer(n, 'skipped')}>見送り</button></>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
    </div>
  );
}

function Deliverables({data, act, post}) {
  const items = data.deliverables;
  const done = items.filter((d) => d.status === 'delivered').length;
  const statuses = data.vocabulary.deliverableStatuses;
  const [form, setForm] = useState({name: '', section: '', owner: '', spec: ''});
  return (
    <div>
      <Big items={[[`${done} / ${items.length}`, '納品済み', 'ok']]} />
      {!items.length && (
        <p><button type="button" onClick={() => act(() => post('/deliverables', {template: 'contract'}))}>契約の型から作る</button></p>
      )}
      <table className="pp-table">
        <thead><tr><th>区分</th><th>物件</th><th>持ち主</th><th>済</th><th>状態</th><th>日</th><th>取引先への納品</th></tr></thead>
        <tbody>
          {items.map((d) => (
            <tr key={d.id}>
              <td>{d.section ?? ''}</td><td className="wrap">{d.name}{d.episodeNo ? `（第${d.episodeNo}話）` : ''}</td><td>{d.owner ?? ''}</td>
              <td className={`pp-mark ${d.status === 'delivered' ? 'ok' : ''}`}>{d.status === 'delivered' ? '✓' : d.status === 'pending' ? '—' : '…'}</td>
              <td><select className={`pp-status ${STATUS_TONE[d.status]}`} value={d.status} onChange={(e) => act(() => post(`/deliverables/${d.id}/events`, {status: e.target.value}))}>
                {Object.entries(statuses).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></td>
              <td>{md(d.onDate)}</td>
              <td>{d.salesDeliverable ? `${d.salesDeliverable.title}（〆 ${md(d.salesDeliverable.dueOn)}・${d.salesDeliverable.status}）` : ''}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <form className="pp-form" onSubmit={async (e) => { e.preventDefault(); if (await act(() => post('/deliverables', {...form, sourceKind: 'manual'}))) setForm({name: '', section: form.section, owner: form.owner, spec: ''}); }}>
        <input className="m" placeholder="区分" value={form.section} onChange={(e) => setForm({...form, section: e.target.value})} />
        <input placeholder="物件" value={form.name} onChange={(e) => setForm({...form, name: e.target.value})} required />
        <input className="m" placeholder="持ち主" value={form.owner} onChange={(e) => setForm({...form, owner: e.target.value})} />
        <input className="l" placeholder="仕様" value={form.spec} onChange={(e) => setForm({...form, spec: e.target.value})} />
        <button type="submit">足す</button>
      </form>
    </div>
  );
}
