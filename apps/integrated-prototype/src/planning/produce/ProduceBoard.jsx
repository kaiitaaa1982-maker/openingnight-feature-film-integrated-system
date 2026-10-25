// プロデュース管理の進行表（要件 docs/requirements/planning/produce-progress.md。会社ルートの plans/2026-10-22-folder-produce.md の「進行表」）。
// 一覧: 案件ごとに1行（初号・納品までの日数・遅れ・次のチェック）。1案件: 上の箱・カレンダー（上に月、日付と曜日、土日を地の色。期間は矢印の帯）・一覧。
// 帯か名前を押すと右に詳細（関連する場所・チェック項目・掲示板・着手と完了・直す）。値は受け口から読むだけで、状態は受け口が予定と記録から導いた値
import React, {useCallback, useEffect, useMemo, useRef, useState} from 'react';
import {Notice} from '../../ui/Notice.jsx';
import './produce.css';

const WD = '日月火水木金土';
const parse = (s) => new Date(`${s}T00:00:00`);
const fmt = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const addDays = (s, n) => { const d = parse(s); d.setDate(d.getDate() + n); return fmt(d); };
const md = (s) => (s ? `${Number(s.slice(5, 7))}/${Number(s.slice(8))}` : '—');
const span = (a, b) => Math.round((parse(b) - parse(a)) / 86400000);
const STATE = {done: ['済', 'mute'], late: ['遅れ', 'late'], now: ['いま', ''], plan: ['予定', 'mute']};
const SPEAKERS = ['P', 'LP', '監督', '編集', '撮影', '録音', '美術'];

// フォルダの画面（フォルダ見本 docs/presentations/2026-10-20-folder-demo/site/folder-view/ の形）。フォルダ名・ひとこと・「いま確認すること」・案件のカード。
// フォルダの入口（?p=folders&f=F02）からも同じ部品を開く（調整役の PR で差し込む）
export default function ProduceBoard({request, initialProjectId = null}) {
  const [list, setList] = useState(null);
  const [projectId, setProjectId] = useState(initialProjectId);
  const [error, setError] = useState(null);
  const load = useCallback(async () => {
    setError(null);
    try { setList(await request('/produce/projects')); } catch (failure) { setError(failure); }
  }, [request]);
  useEffect(() => { load(); }, [load]);
  if (projectId != null) return <Board request={request} projectId={projectId} onBack={() => { setProjectId(null); load(); }} />;
  const rows = list ? [...list.projects].sort((a, b) => (b.summary.late - a.summary.late) || (b.taskCount - a.taskCount) || a.id - b.id) : [];
  const todos = rows.flatMap((p) => [
    ...(p.summary.late ? [{key: `${p.id}-late`, tone: 'late', project: p, text: `遅れているチケットが ${p.summary.late}件`, when: ''}] : []),
    ...(p.summary.nextCheck ? [{key: `${p.id}-chk`, tone: 'soon', project: p, text: `次のチェック「${p.summary.nextCheck.title}」${p.summary.nextCheck.checkers ? `（${p.summary.nextCheck.checkers}）` : ''}`, when: md(p.summary.nextCheck.start)}] : []),
  ]);
  return (
    <section className="pd pd-folder" data-page="produce-list" data-folder-code="F02">
      <ol className="pd-path" aria-label="現在地"><li>フォルダ</li><li>プロデュース管理</li></ol>
      <h1 className="pd-h1">プロデュース管理</h1>
      {error && <Notice error={error} onRetry={load} retryLabel="読み直す" />}
      {!list ? <p aria-busy="true">読込中…</p> : <>
        {todos.length > 0 && <div className={`pd-card ${todos.some((t) => t.tone === 'late') ? 'check' : ''}`}>
          <h2>いま確認すること</h2>
          {todos.map((t) => (
            <button type="button" key={t.key} className="pd-todo" onClick={() => setProjectId(t.project.id)}>
              <span className={`pd-tag ${t.tone === 'late' ? 'late' : ''}`}>{t.tone === 'late' ? '遅れ' : 'まもなく'}</span>
              <span><b>{t.project.title}</b> {t.text}</span><span className="pd-when">{t.when}</span>
            </button>))}
        </div>}
        <div className="pd-cards">
          {rows.map((p) => (
            <button type="button" key={p.id} className="pd-card pd-anken" onClick={() => setProjectId(p.id)} data-project={p.id}>
              <span className="pd-kicker">{p.code}</span>
              <span className="pd-ttl">{p.title}</span>
              <span className="pd-facts">
                <span><small>初号まで</small><b>{p.summary.firstPrint ? `${p.summary.firstPrint.days}日` : '—'}</b></span>
                <span><small>納品まで</small><b>{p.summary.delivery ? `${p.summary.delivery.days}日` : '—'}</b></span>
                <span><small>チェック</small><b>{p.summary.checks.total ? `${p.summary.checks.done}/${p.summary.checks.total}` : '—'}</b></span>
              </span>
              <span className="pd-state">{p.summary.late ? <span className="pd-tag late">遅れ {p.summary.late}</span> : p.taskCount ? <span className="pd-tag">順調</span> : <span className="pd-tag mute">未</span>}</span>
            </button>
          ))}
        </div>
      </>}
    </section>
  );
}

function Board({request, projectId, onBack}) {
  const base = `/produce/projects/${projectId}`;
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [view, setView] = useState('cal');
  const [months, setMonths] = useState(3);
  const [start, setStart] = useState(null);
  const [filter, setFilter] = useState('all');
  const [allRows, setAllRows] = useState(false);
  const [open, setOpen] = useState(null);
  const [modal, setModal] = useState(null);
  const [message, setMessage] = useState(null);
  const load = useCallback(async () => {
    setError(null);
    try {
      const next = await request(base);
      setData(next);
      setStart((s) => s ?? `${next.today.slice(0, 7)}-01`);
    } catch (failure) { setError(failure); }
  }, [request, base]);
  useEffect(() => { load(); }, [load]);
  const act = async (fn, done) => {
    setMessage(null);
    try { await fn(); await load(); if (done) setMessage(done); return true; } catch (failure) { setMessage(failure.message || String(failure)); return false; }
  };
  if (error) return <section className="pd"><button onClick={onBack}>← 一覧</button><Notice error={error} onRetry={load} retryLabel="読み直す" /></section>;
  if (!data || !start) return <section className="pd"><p aria-busy="true">読込中…</p></section>;
  const phaseLabel = Object.fromEntries(data.vocab.phases.map((p) => [p.code, p.label]));
  const roleLabel = Object.fromEntries(data.vocab.roles.map((r) => [r.code, r.label]));
  const shown = data.tasks.filter((t) => filter === 'all' || (filter === 'check' ? t.kind === 'check' : t.role === filter));
  const s = data.summary;
  const current = open == null ? null : data.tasks.find((t) => t.taskUid === open);
  return (
    <section className="pd" data-page="produce-board" data-project={projectId}>
      <ol className="pd-path" aria-label="現在地"><li>フォルダ</li><li><button type="button" className="pd-crumb" onClick={onBack}>プロデュース管理</button></li><li>{data.project.title}</li><li>進行表</li></ol>
      <h1 className="pd-h1">{data.project.title}<span className="pd-sub" style={{marginLeft: 10, fontWeight: 400}}>{data.project.code}</span></h1>
      <div className="pd-sum">
        <Box k="初号まで" v={s.firstPrint ? `${s.firstPrint.days}日` : '—'} d={s.firstPrint ? md(s.firstPrint.date) : ''} />
        <Box k="納品まで" v={s.delivery ? `${s.delivery.days}日` : '—'} d={s.delivery ? md(s.delivery.date) : ''} />
        <Box k={s.checks.until ? '初号までのチェック' : 'チェック'} v={`${s.checks.total}回`} d={`済 ${s.checks.done}・残り ${s.checks.total - s.checks.done}`} />
        <Box k="次のチェック" v={s.nextCheck ? s.nextCheck.title : '—'} d={s.nextCheck ? `${md(s.nextCheck.start)}〜${md(s.nextCheck.end)} ${s.nextCheck.checkers ?? ''}` : ''} small />
        <Box k="遅れ" v={s.late ? `${s.late}件` : 'なし'} d="" late={s.late > 0} onClick={s.late ? () => setFilter('all') : undefined} />
      </div>
      <div className="pd-tools">
        <span className="pd-seg"><button className={view === 'cal' ? 'on' : ''} onClick={() => setView('cal')}>カレンダー</button><button className={view === 'list' ? 'on' : ''} onClick={() => setView('list')}>一覧</button></span>
        {view === 'cal' && <>
          <button onClick={() => setStart(shiftMonth(start, -1))}>‹</button>
          <span className="pd-seg">{[1, 3, 6].map((n) => <button key={n} className={months === n ? 'on' : ''} onClick={() => setMonths(n)}>{n}か月</button>)}</span>
          <button onClick={() => setStart(shiftMonth(start, 1))}>›</button>
          <button onClick={() => setStart(`${data.today.slice(0, 7)}-01`)}>今日</button>
          <button className={allRows ? 'on' : ''} onClick={() => setAllRows(!allRows)}>全部の行</button>
        </>}
        <span className="pd-seg">{[['all', '全員'], ['producer', 'P'], ['line_producer', 'LP'], ['check', 'チェック']].map(([k, n]) => <button key={k} className={filter === k ? 'on' : ''} onClick={() => setFilter(k)}>{n}</button>)}</span>
        <span className="pd-sp" />
        {data.canEdit && <>
          <button onClick={() => setModal({type: 'template'})}>テンプレートを当てる</button>
          <button onClick={() => setModal({type: 'save'})} disabled={!data.tasks.length}>テンプレートとして残す</button>
          <button className="p" onClick={() => setModal({type: 'task'})}>＋チケット</button>
        </>}
      </div>
      {message && <p className="pd-sub" role="status">{message}</p>}
      {!data.tasks.length ? (
        <div style={{border: '1px solid var(--ink)', padding: 24, textAlign: 'center'}}>
          {data.canEdit && <p><button className="p" onClick={() => setModal({type: 'template'})}>テンプレートを当てる</button> <button onClick={() => setModal({type: 'task'})}>＋チケット</button></p>}
        </div>
      ) : view === 'cal' ? (
        <Calendar tasks={shown} start={start} months={months} today={data.today} allRows={allRows} phaseLabel={phaseLabel} phases={data.vocab.phases}
          posts={data.posts} onOpen={setOpen} />
      ) : (
        <table className="pd-list">
          <thead><tr><th>段</th><th>チケット</th><th>役</th><th>担当・チェック</th><th>開始</th><th>終了</th><th>状態</th></tr></thead>
          <tbody>{shown.map((t) => (
            <tr key={t.taskUid} className="click" onClick={() => setOpen(t.taskUid)}>
              <td className="pd-sub">{phaseLabel[t.phase]}</td>
              <td>{t.kind === 'milestone' ? '◆ ' : ''}{t.title}{t.kind === 'check' && <span className="pd-tag">チェック</span>}{!t.templateLabel && <span className="pd-tag mute">追加</span>}</td>
              <td>{roleLabel[t.role]}</td><td>{t.kind === 'check' ? t.checkers : t.assigneeLabel}</td>
              <td>{md(t.plannedStart)}</td><td>{md(t.plannedEnd)}</td><td><span className={`pd-tag ${STATE[t.state][1]}`}>{STATE[t.state][0]}</span></td>
            </tr>))}</tbody>
        </table>
      )}
      {current && <Drawer task={current} data={data} base={base} request={request} act={act} roleLabel={roleLabel} phaseLabel={phaseLabel}
        onEdit={() => setModal({type: 'task', task: current})} onClose={() => setOpen(null)} />}
      {modal?.type === 'task' && <TaskForm data={data} task={modal.task} onClose={() => setModal(null)}
        onSave={(body) => act(() => modal.task ? request(`${base}/tasks/${modal.task.taskUid}/versions`, {method: 'POST', body: {...body, baseVersionNo: modal.task.versionNo}})
          : request(`${base}/tasks`, {method: 'POST', body}), modal.task ? '直しました（新しい版）' : 'チケットを足しました').then((ok) => ok && setModal(null))} />}
      {modal?.type === 'template' && <TemplateForm request={request} data={data} onClose={() => setModal(null)}
        onApply={(body) => act(() => request(`${base}/apply-template`, {method: 'POST', body}), 'テンプレートからチケットを作りました').then((ok) => ok && setModal(null))} />}
      {modal?.type === 'save' && <SaveForm title={data.project.title} count={data.tasks.length} onClose={() => setModal(null)}
        onSave={(name) => act(() => request(`${base}/save-template`, {method: 'POST', body: {name}}), 'テンプレートとして残しました').then((ok) => ok && setModal(null))} />}
    </section>
  );
}

function shiftMonth(start, n) { const d = parse(start); d.setMonth(d.getMonth() + n); return fmt(d); }

function Box({k, v, d, late, small, onClick}) {
  return <div className={`pd-box ${late ? 'late' : ''}`} onClick={onClick} style={onClick ? {cursor: 'pointer'} : undefined}>
    <div className="k">{k}</div><div className="v" style={small ? {fontSize: 14} : undefined}>{v}</div><div className="d">{d}</div></div>;
}

function Calendar({tasks, start, months, today, allRows, phases, phaseLabel, posts, onOpen}) {
  const wrap = useRef(null);
  const {days, monthHeads, end} = useMemo(() => {
    const first = parse(start); const last = new Date(first); last.setMonth(last.getMonth() + months); last.setDate(0);
    const list = []; for (let d = new Date(first); d <= last; d.setDate(d.getDate() + 1)) list.push(fmt(d));
    const heads = []; for (const day of list) { const m = day.slice(0, 7); if (!heads.length || heads.at(-1).m !== m) heads.push({m, n: 1}); else heads.at(-1).n += 1; }
    return {days: list, monthHeads: heads, end: list.at(-1)};
  }, [start, months]);
  useEffect(() => {
    const cell = wrap.current?.querySelector('thead tr.d th.td');
    if (cell) wrap.current.scrollLeft = Math.max(0, cell.offsetLeft - 280);
  }, [start, months]);
  const rows = tasks.filter((t) => allRows || (t.plannedEnd >= start && t.plannedStart <= end));
  const postCount = (uid) => posts.filter((p) => p.taskUid === uid).length;
  const cls = (day) => { const g = parse(day).getDay(); return `${g === 0 || g === 6 ? 'we' : ''} ${day === today ? 'td' : ''}`; };
  return (
    <>
      <div className="pd-grid" ref={wrap}>
        <table>
          <thead>
            <tr className="m"><th className="nm" />{monthHeads.map((h) => <th key={h.m} colSpan={h.n}><span style={{position: 'sticky', left: 228}}>{h.m.slice(0, 4)}年{Number(h.m.slice(5))}月</span></th>)}</tr>
            <tr className="d"><th className="nm" />{days.map((d) => <th key={d} className={cls(d)}>{Number(d.slice(8))}</th>)}</tr>
            <tr className="w"><th className="nm" />{days.map((d) => <th key={d} className={cls(d)}>{WD[parse(d).getDay()]}</th>)}</tr>
          </thead>
          <tbody>
            {phases.map((ph) => {
              const group = rows.filter((t) => t.phase === ph.code);
              if (!group.length) return null;
              return (
                <React.Fragment key={ph.code}>
                  <tr className="ph"><td className="nm">{phaseLabel[ph.code]}</td>{days.map((d) => <td key={d} className={cls(d)} />)}</tr>
                  {group.map((t) => (
                    <tr key={t.taskUid}>
                      <td className="nm" onClick={() => onOpen(t.taskUid)} title={t.title}>
                        {t.kind === 'milestone' ? '◆ ' : ''}{t.title}
                        {t.state === 'late' && <span className="pd-tag late">遅れ</span>}
                        {t.kind === 'check' && t.state !== 'late' && <span className="pd-tag">チェック</span>}
                        {postCount(t.taskUid) > 0 && <span className="pd-tag mute">💬{postCount(t.taskUid)}</span>}
                      </td>
                      {days.map((d, i) => {
                        const first = d === t.plannedStart || (i === 0 && t.plannedStart < d && t.plannedEnd >= d);
                        let inner = null;
                        if (first && t.plannedEnd >= d) {
                          if (t.kind === 'milestone') inner = d === t.plannedStart ? <div className={`pd-dia ${t.state === 'late' ? 'late' : t.state === 'done' ? 'done' : ''}`} onClick={() => onOpen(t.taskUid)} title={t.title} /> : null;
                          else {
                            const last = t.plannedEnd > end ? end : t.plannedEnd;
                            const width = (span(d, last) + 1) * 24 - 2;
                            const tone = t.state === 'done' ? 'done' : t.state === 'late' ? 'late' : '';
                            inner = <div className={`pd-bar ${t.kind === 'check' ? 'chk' : ''} ${tone}`} style={{left: 1, width}} onClick={() => onOpen(t.taskUid)} title={`${t.title} ${md(t.plannedStart)}〜${md(t.plannedEnd)}`}>
                              <span>{t.title}{t.kind === 'check' && t.checkers ? `（${t.checkers}）` : ''}</span></div>;
                          }
                        }
                        return <td key={d} className={`cell ${cls(d)}`}>{inner}</td>;
                      })}
                    </tr>
                  ))}
                </React.Fragment>
              );
            })}
          </tbody>
        </table>
      </div>
    </>
  );
}

function Drawer({task, data, base, request, act, roleLabel, phaseLabel, onEdit, onClose}) {
  const [label, setLabel] = useState('');
  const [speaker, setSpeaker] = useState('P');
  const [text, setText] = useState('');
  const [link, setLink] = useState({label: '', target: ''});
  const path = `${base}/tasks/${task.taskUid}`;
  const checks = data.checks.filter((c) => c.taskUid === task.taskUid);
  const posts = data.posts.filter((p) => p.taskUid === task.taskUid);
  const links = data.links.filter((l) => l.taskUid === task.taskUid);
  const events = data.events.filter((e) => e.taskUid === task.taskUid);
  const ev = (kind) => act(() => request(`${path}/events`, {method: 'POST', body: {kind}}), kind === 'done' ? '完了にしました' : kind === 'started' ? '着手しました' : '戻しました');
  const ed = data.canEdit;
  return (
    <aside className="pd-drawer" role="dialog" aria-label={task.title}>
      <div className="pd-dh">
        <button onClick={onClose} style={{float: 'right'}}>✕</button>
        <div className="pd-sub">{phaseLabel[task.phase]}・{roleLabel[task.role]}{task.kind === 'check' ? '・チェック期間' : task.kind === 'milestone' ? '・節目' : ''}{task.templateLabel ? `・${task.templateLabel}` : ''}</div>
        <h3>{task.title}</h3>
        <div>{md(task.plannedStart)}{task.plannedEnd !== task.plannedStart ? ` 〜 ${md(task.plannedEnd)}（${span(task.plannedStart, task.plannedEnd) + 1}日）` : ''}
          <span className={`pd-tag ${STATE[task.state][1]}`}>{STATE[task.state][0]}</span> <span className="pd-sub">v{task.versionNo}</span></div>
        {task.kind === 'check' && task.checkers && <div style={{marginTop: 4}}>チェックする人: {task.checkers.split(/[・,、]/).map((c) => <span key={c} className="pd-tag">{c}</span>)}</div>}
        {task.kind !== 'check' && task.assigneeLabel && <div className="pd-sub">担当: {task.assigneeLabel}</div>}
      </div>
      <div className="pd-db">
        <div className="pd-sec">関連する場所</div>
        {links.map((l) => (
          <div key={l.linkUid} className="pd-row">
            <a className={`pd-link ${l.isFallback ? 'fb' : ''}`} style={{flex: 1}} href={l.target} target={l.target.startsWith('https://') ? '_blank' : undefined} rel="noreferrer">↪ {l.label}<span className="f">{l.isFallback ? '仮' : ''}</span></a>
            {ed && <button title="外す" onClick={() => act(() => request(`${path}/links`, {method: 'POST', body: {remove: true, linkUid: l.linkUid}}))}>×</button>}
          </div>))}
        {ed && <div className="pd-row"><input placeholder="名前" value={link.label} onChange={(e) => setLink({...link, label: e.target.value})} />
          <input placeholder="?p= / https://" value={link.target} onChange={(e) => setLink({...link, target: e.target.value})} />
          <button onClick={() => act(() => request(`${path}/links`, {method: 'POST', body: link})).then((ok) => ok && setLink({label: '', target: ''}))}>足す</button></div>}

        <div className="pd-sec">チェック項目</div>
        {checks.map((c) => (
          <label key={c.checkUid} style={{display: 'flex', gap: 6, padding: '3px 0'}}>
            <input type="checkbox" checked={c.checked} disabled={!ed} onChange={(e) => act(() => request(`${path}/checks`, {method: 'POST', body: {checkUid: c.checkUid, checked: e.target.checked}}))} /> {c.label}
          </label>))}
        {ed && <div className="pd-row"><input placeholder="チェック項目" value={label} onChange={(e) => setLabel(e.target.value)} />
          <button onClick={() => act(() => request(`${path}/checks`, {method: 'POST', body: {label}})).then((ok) => ok && setLabel(''))}>足す</button></div>}

        <div className="pd-sec">掲示板</div>
        {posts.map((p) => <div key={p.id} className="pd-post"><div className="h"><b>{p.speakerLabel}</b>　{String(p.createdAt).slice(5, 16).replace('T', ' ')}</div>{p.body}</div>)}
        {ed && <div className="pd-row">
          <select value={speaker} onChange={(e) => setSpeaker(e.target.value)}>{SPEAKERS.map((x) => <option key={x}>{x}</option>)}</select>
          <input placeholder="" value={text} onChange={(e) => setText(e.target.value)} />
          <button className="p" onClick={() => act(() => request(`${path}/posts`, {method: 'POST', body: {speakerLabel: speaker, body: text}})).then((ok) => ok && setText(''))}>書く</button></div>}

        <div className="pd-sec">記録</div>
        {events.length > 0 && <div className="pd-sub">{events.map((e) => `${md(e.onDate)} ${e.kind === 'done' ? '完了' : e.kind === 'started' ? '着手' : '戻す'}`).join('／')}</div>}
        {ed && <div className="pd-row">
          {task.state !== 'done' && !events.some((e) => e.kind === 'started') && <button onClick={() => ev('started')}>着手</button>}
          {task.state === 'done' ? <button onClick={() => ev('reopened')}>完了を戻す</button> : <button className="p" onClick={() => ev('done')}>完了にする</button>}
          <button onClick={onEdit}>直す</button>
        </div>}
      </div>
    </aside>
  );
}

function TaskForm({data, task, onSave, onClose}) {
  const [v, setV] = useState(() => task ? {title: task.title, phase: task.phase, kind: task.kind, role: task.role, assigneeLabel: task.assigneeLabel ?? '', checkers: task.checkers ?? '',
    plannedStart: task.plannedStart, plannedEnd: task.plannedEnd, milestoneCode: task.milestoneCode ?? '', workId: task.workId ?? '', reason: '', retired: false}
    : {title: '', phase: 'post', kind: 'work', role: 'producer', assigneeLabel: '', checkers: '', plannedStart: data.today, plannedEnd: addDays(data.today, 6), milestoneCode: '', workId: ''});
  const set = (k) => (e) => setV({...v, [k]: e.target.type === 'checkbox' ? e.target.checked : e.target.value});
  return (
    <aside className="pd-drawer" role="dialog" aria-label={task ? 'チケットを直す' : '＋チケット'}>
      <div className="pd-dh"><button onClick={onClose} style={{float: 'right'}}>✕</button><h3>{task ? 'チケットを直す' : '＋チケット'}</h3></div>
      <div className="pd-db pd-form">
        <label>名前</label><input value={v.title} onChange={set('title')} placeholder="" />
        <div className="two">
          <div><label>種類</label><select value={v.kind} onChange={set('kind')}>{data.vocab.kinds.map((k) => <option key={k.code} value={k.code}>{k.label}</option>)}</select></div>
          <div><label>段</label><select value={v.phase} onChange={set('phase')}>{data.vocab.phases.map((p) => <option key={p.code} value={p.code}>{p.label}</option>)}</select></div>
        </div>
        <div className="two">
          <div><label>役</label><select value={v.role} onChange={set('role')}>{data.vocab.roles.map((r) => <option key={r.code} value={r.code}>{r.label}</option>)}</select></div>
          <div><label>{v.kind === 'check' ? 'チェックする人（・で区切る）' : '担当'}</label>
            {v.kind === 'check' ? <input value={v.checkers} onChange={set('checkers')} placeholder="監督・P" /> : <input value={v.assigneeLabel} onChange={set('assigneeLabel')} placeholder="" />}</div>
        </div>
        <div className="two">
          <div><label>{v.kind === 'milestone' ? '日' : '開始'}</label><input type="date" value={v.plannedStart} onChange={set('plannedStart')} /></div>
          {v.kind !== 'milestone' && <div><label>終了</label><input type="date" value={v.plannedEnd} onChange={set('plannedEnd')} /></div>}
        </div>
        {v.kind === 'milestone' && <><label>節目</label><select value={v.milestoneCode} onChange={set('milestoneCode')}><option value="">（なし）</option>{data.vocab.milestones.map((m) => <option key={m.code} value={m.code}>{m.label}</option>)}</select></>}
        {data.works.length > 0 && <><label>作品（任意）</label><select value={v.workId} onChange={set('workId')}><option value="">（案件全体）</option>{data.works.map((w) => <option key={w.id} value={w.id}>{w.title}</option>)}</select></>}
        {task && <><label>直す理由（必須）</label><input value={v.reason} onChange={set('reason')} placeholder="" />
          <label style={{display: 'flex', gap: 6, alignItems: 'center'}}><input type="checkbox" checked={v.retired} onChange={set('retired')} style={{width: 'auto'}} /> このチケットをやめる</label></>}
        <div className="pd-row" style={{justifyContent: 'flex-end', marginTop: 14}}>
          <button onClick={onClose}>やめる</button>
          <button className="p" onClick={() => onSave({...v, workId: v.workId === '' ? null : Number(v.workId), milestoneCode: v.milestoneCode || null,
            plannedEnd: v.kind === 'milestone' ? v.plannedStart : v.plannedEnd})}>{task ? '新しい版で残す' : '足す'}</button>
        </div>
      </div>
    </aside>
  );
}

function TemplateForm({request, data, onApply, onClose}) {
  const [templates, setTemplates] = useState(null);
  const [id, setId] = useState('standard');
  const [anchor, setAnchor] = useState(data.today);
  const [workId, setWorkId] = useState('');
  useEffect(() => { request('/produce/templates').then((r) => setTemplates(r.templates)).catch(() => setTemplates([])); }, [request]);
  const chosen = templates?.find((t) => String(t.id) === String(id));
  return (
    <aside className="pd-drawer" role="dialog" aria-label="テンプレートを当てる">
      <div className="pd-dh"><button onClick={onClose} style={{float: 'right'}}>✕</button><h3>テンプレートを当てる</h3></div>
      <div className="pd-db pd-form">
        {!templates ? <p aria-busy="true">読込中…</p> : <>
          <label>テンプレート</label>
          <select value={id} onChange={(e) => setId(e.target.value)}>{templates.map((t) => <option key={t.id} value={t.id}>{t.name}（{t.items.length}件）</option>)}</select>
          <label>{chosen?.anchorKind === 'project_start' ? '起点（最初の開始日）' : '起点（クランクインの日）'}</label>
          <input type="date" value={anchor} onChange={(e) => setAnchor(e.target.value)} />
          {data.works.length > 0 && <><label>作品（任意）</label><select value={workId} onChange={(e) => setWorkId(e.target.value)}><option value="">（案件全体）</option>{data.works.map((w) => <option key={w.id} value={w.id}>{w.title}</option>)}</select></>}
          {chosen && <table className="pd-list"><tbody>{chosen.items.slice(0, 40).map((i) => <tr key={i.sortNo}><td>{i.title}</td><td className="pd-sub">{i.startOffsetDays >= 0 ? '+' : ''}{i.startOffsetDays}日</td></tr>)}</tbody></table>}
          <div className="pd-row" style={{justifyContent: 'flex-end', marginTop: 14}}>
            <button onClick={onClose}>やめる</button>
            <button className="p" onClick={() => onApply({templateId: id === 'standard' ? 'standard' : Number(id), anchorDate: anchor, workId: workId === '' ? null : Number(workId)})}>当てる</button>
          </div>
        </>}
      </div>
    </aside>
  );
}

function SaveForm({title, count, onSave, onClose}) {
  const [name, setName] = useState(`${title}の進行`);
  return (
    <aside className="pd-drawer" role="dialog" aria-label="テンプレートとして残す">
      <div className="pd-dh"><button onClick={onClose} style={{float: 'right'}}>✕</button><h3>テンプレートとして残す</h3></div>
      <div className="pd-db pd-form">
        <p>{count}件</p>
        <label>名前</label><input value={name} onChange={(e) => setName(e.target.value)} />
        <div className="pd-row" style={{justifyContent: 'flex-end', marginTop: 14}}><button onClick={onClose}>やめる</button><button className="p" onClick={() => onSave(name)}>残す</button></div>
      </div>
    </aside>
  );
}
