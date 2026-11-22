// 小道具（持ち道具・消え物など）の画面（ページ ID `小道具`、`?p=props`。移行 0061。会社ルートの plans/2026-11-09-props-meeting.md）。
// 案A「一覧」: 撮影日ごとの一覧を絞り込み、行を選ぶと右の欄で担当・状態・次の行動を直す（版の履歴つき）。
// 案B「打ち合わせ」: 回を選び、未割当・要調整を1品目ずつ決めて次へ。決めた版はその回の記録として右に並ぶ。
// 「看板」: 担当ごとの件数と5状態の列（PropsBoard.jsx。要件 docs/requirements/production/props-board.md）。
// 見た目は docs/design/integrated-system-visual.md（黒・白・灰と赤1色、角丸0・影なし、状態は文字の札）。赤は「要確認」の数だけ。
import React, {useCallback, useEffect, useMemo, useState} from 'react';
import {filterRows, meetingQueue, stateCounts, versionInput} from './props-model.mjs';
import PropsBoard from './PropsBoard.jsx';
import './props.css';

const md = (d) => (d ? `${Number(d.slice(5, 7))}/${Number(d.slice(8, 10))}` : '—');
const today = () => new Date(Date.now() + 9 * 3600000).toISOString().slice(0, 10);
const blankItem = {sceneLabel: '', shootOn: '', place: '', name: '', quantity: '', kind: 'hand', department: '', ownerLabel: '', state: 'unassigned',
  nextAction: '', dueOn: '', source: 'manual', scriptNote: '', memo: ''};
const toForm = (r) => Object.fromEntries(Object.keys(blankItem).map((k) => [k, r[k] ?? '']));
const toBody = (v) => Object.fromEntries(Object.entries(v).map(([k, x]) => [k, x === '' ? null : x]));
const entries = (map) => Object.entries(map || {});

function Owner({row, vocab}) {
  if (!row.department) return <span className="prp-sub">—</span>;
  return <>{vocab.departments[row.department]}{row.ownerLabel && <div className="prp-sub">{row.ownerLabel}</div>}</>;
}

function Fields({v, set, vocab, full}) {
  const on = (k) => (e) => set({...v, [k]: e.target.value});
  return (
    <>
      {full && <label className="prp-wide"><span>品目</span><input value={v.name} onChange={on('name')} /></label>}
      {full && <label><span>シーン</span><input value={v.sceneLabel} onChange={on('sceneLabel')} /></label>}
      {full && <label><span>撮影日</span><input type="date" value={v.shootOn} onChange={on('shootOn')} /></label>}
      {full && <label className="prp-wide"><span>場面</span><input value={v.place} onChange={on('place')} /></label>}
      <label><span>数</span><input value={v.quantity} onChange={on('quantity')} /></label>
      {full && <label><span>種別</span><select value={v.kind} onChange={on('kind')}>{entries(vocab.kinds).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></label>}
      <label><span>部署</span><select value={v.department} onChange={(e) => set({...v, department: e.target.value, state: e.target.value && v.state === 'unassigned' ? 'arranging' : v.state})}>
        <option value="">—</option>{entries(vocab.departments).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></label>
      <label><span>担当</span><input value={v.ownerLabel} onChange={on('ownerLabel')} /></label>
      <label><span>状態</span><select value={v.state} onChange={on('state')}>{entries(vocab.states).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></label>
      <label className="prp-wide"><span>次の行動</span><input value={v.nextAction} onChange={on('nextAction')} /></label>
      <label><span>期限</span><input type="date" value={v.dueOn} onChange={on('dueOn')} /></label>
      <label className="prp-wide"><span>メモ</span><input value={v.memo} onChange={on('memo')} /></label>
    </>
  );
}

// 案A の右の欄: 直す・版の履歴
function Editor({row, vocab, canWrite, request, onSaved}) {
  const [v, setV] = useState(toForm(row));
  const [history, setHistory] = useState([]);
  const [err, setErr] = useState('');
  useEffect(() => { setV(toForm(row)); setErr(''); }, [row]);
  useEffect(() => {
    let alive = true;
    request(`/props/items/${row.id}`).then((r) => alive && setHistory(r.versions || [])).catch(() => alive && setHistory([]));
    return () => { alive = false; };
  }, [row.id, row.versionNo, request]);
  async function save(e) {
    e.preventDefault(); setErr('');
    try { await request(`/props/items/${row.id}/versions`, {method: 'POST', body: JSON.stringify({...toBody(v), baseVersionNo: row.versionNo})}); onSaved(); }
    catch (x) { setErr(x.message || '保存できませんでした'); }
  }
  return (
    <form className="prp-panel" aria-label="品目" onSubmit={save}>
      <div className="prp-sub">{md(row.shootOn)}　{row.sceneLabel || ''}　{row.place || ''}</div>
      <div className="prp-name">{row.name}</div>
      {row.scriptNote && <div className="prp-script">{row.scriptNote}</div>}
      <div className="prp-form"><Fields v={v} set={setV} vocab={vocab} full /></div>
      {canWrite && <div className="prp-act"><button type="submit" className="on">保存</button>{err && <span className="prp-stop">{err}</span>}</div>}
      <ol className="prp-hist" aria-label="版">
        {[...history].reverse().map((h) => (
          <li key={h.versionNo}>版{h.versionNo}　{md(h.updatedAt?.slice(0, 10))}　{vocab.states[h.state]}{h.department ? `・${vocab.departments[h.department]}` : ''}{h.meetingTitle ? `　${h.meetingTitle}` : ''}</li>
        ))}
      </ol>
    </form>
  );
}

function ListMode({data, request, reload, canWrite}) {
  const [f, setF] = useState({shootOn: '', department: '', state: '', kind: '', text: ''});
  const [selected, setSelected] = useState(null);
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState(blankItem);
  const [err, setErr] = useState('');
  const {items, vocab} = data;
  const rows = useMemo(() => filterRows(items, {shootOn: f.shootOn || null, department: f.department || null, state: f.state || null, kind: f.kind || null, text: f.text || null}), [items, f]);
  const days = useMemo(() => [...new Set(items.map((r) => r.shootOn).filter(Boolean))].sort(), [items]);
  const current = items.find((r) => r.id === selected) || null;
  const on = (k) => (e) => setF({...f, [k]: e.target.value});
  async function create(e) {
    e.preventDefault(); setErr('');
    try { const r = await request('/props/items', {method: 'POST', body: JSON.stringify({...toBody(draft), workId: data.workId})}); setAdding(false); setDraft(blankItem); setSelected(r.id); reload(); }
    catch (x) { setErr(x.message || '保存できませんでした'); }
  }
  let lastDay = null;
  return (
    <>
      <div className="prp-bar">
        <select aria-label="撮影日" value={f.shootOn} onChange={on('shootOn')}><option value="">撮影日</option>{days.map((d) => <option key={d} value={d}>{md(d)}</option>)}<option value="none">日付なし</option></select>
        <select aria-label="部署" value={f.department} onChange={on('department')}><option value="">部署</option>{entries(vocab.departments).map(([k, l]) => <option key={k} value={k}>{l}</option>)}<option value="none">部署なし</option></select>
        <select aria-label="状態" value={f.state} onChange={on('state')}><option value="">状態</option>{entries(vocab.states).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select>
        <select aria-label="種別" value={f.kind} onChange={on('kind')}><option value="">種別</option>{entries(vocab.kinds).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select>
        <input aria-label="品目で探す" placeholder="品目" value={f.text} onChange={on('text')} />
        <span className="prp-fill" />
        <span className="prp-sub">{rows.length} / {items.length}</span>
        {canWrite && <button type="button" onClick={() => setAdding(!adding)}>＋ 品目</button>}
      </div>
      {adding && (
        <form className="prp-form prp-new" aria-label="品目を足す" onSubmit={create}>
          <Fields v={draft} set={setDraft} vocab={vocab} full />
          <div className="prp-act"><button type="submit" className="on">足す</button><button type="button" onClick={() => setAdding(false)}>やめる</button>{err && <span className="prp-stop">{err}</span>}</div>
        </form>
      )}
      <div className="prp-split">
        <div className="prp-scroll">
          <table aria-label="小道具">
            <thead><tr><th>シーン</th><th>品目</th><th className="prp-num">数</th><th>種別</th><th>担当</th><th>状態</th><th>次の行動</th></tr></thead>
            <tbody>
              {rows.map((r) => {
                const head = r.shootOn !== lastDay; lastDay = r.shootOn;
                return (
                  <React.Fragment key={r.id}>
                    {head && <tr className="prp-day"><td colSpan={7}>{r.shootOn ? md(r.shootOn) : '日付なし'}</td></tr>}
                    <tr className={r.id === selected ? 'prp-sel' : ''} onClick={() => setSelected(r.id)} aria-selected={r.id === selected}>
                      <td>{r.sceneLabel || '—'}</td><td>{r.name}</td><td className="prp-num">{r.quantity || ''}</td><td>{vocab.kinds[r.kind]}</td>
                      <td><Owner row={r} vocab={vocab} /></td><td><span className="prp-tag">{vocab.states[r.state]}</span></td>
                      <td>{r.nextAction || ''}{r.dueOn && <span className="prp-sub">　{md(r.dueOn)}</span>}</td>
                    </tr>
                  </React.Fragment>
                );
              })}
              {!rows.length && <tr><td colSpan={7} className="prp-sub">—</td></tr>}
            </tbody>
          </table>
        </div>
        {current ? <Editor row={current} vocab={vocab} canWrite={canWrite} request={request} onSaved={reload} /> : <div className="prp-panel prp-sub">—</div>}
      </div>
    </>
  );
}

function NewMeeting({vocab, onCreate, onCancel}) {
  const [v, setV] = useState({heldOn: today(), title: '小道具打ち合わせ', departments: ['production', 'producer', 'direction']});
  const [err, setErr] = useState('');
  const toggle = (k) => setV({...v, departments: v.departments.includes(k) ? v.departments.filter((x) => x !== k) : [...v.departments, k]});
  return (
    <form className="prp-form" aria-label="打ち合わせを始める" onSubmit={async (e) => { e.preventDefault(); setErr(''); try { await onCreate(v); } catch (x) { setErr(x.message || '保存できませんでした'); } }}>
      <label><span>日付</span><input type="date" value={v.heldOn} onChange={(e) => setV({...v, heldOn: e.target.value})} /></label>
      <label className="prp-wide"><span>題</span><input value={v.title} onChange={(e) => setV({...v, title: e.target.value})} /></label>
      <fieldset className="prp-deps"><legend>出た部署</legend>
        {entries(vocab.departments).map(([k, l]) => <label key={k} className="prp-check"><input type="checkbox" checked={v.departments.includes(k)} onChange={() => toggle(k)} />{l}</label>)}
      </fieldset>
      <div className="prp-act"><button type="submit" className="on">始める</button>{onCancel && <button type="button" onClick={onCancel}>やめる</button>}{err && <span className="prp-stop">{err}</span>}</div>
    </form>
  );
}

// 案B: 未割当・要調整を1品目ずつ決める
function MeetingMode({data, request, reload, canWrite}) {
  const {items, vocab, meetings} = data;
  const [meetingId, setMeetingId] = useState(meetings[0]?.id ?? null);
  const [starting, setStarting] = useState(!meetings.length);
  const [all, setAll] = useState(false);
  const [current, setCurrent] = useState(null);
  const [v, setV] = useState(blankItem);
  const [decisions, setDecisions] = useState([]);
  const [err, setErr] = useState('');
  const queue = useMemo(() => meetingQueue(items, {all}), [items, all]);
  const row = queue.find((r) => r.id === current) || queue[0] || null;
  useEffect(() => { if (row) setV(toForm(row)); setErr(''); }, [row?.id, row?.versionNo]); // eslint-disable-line react-hooks/exhaustive-deps
  const loadDecisions = useCallback(() => {
    if (!meetingId) { setDecisions([]); return; }
    request(`/props/meetings/${meetingId}`).then((r) => setDecisions(r.decisions || [])).catch(() => setDecisions([]));
  }, [meetingId, request]);
  useEffect(loadDecisions, [loadDecisions, items]);
  const meeting = meetings.find((m) => m.id === meetingId);
  async function start(form) {
    const r = await request('/props/meetings', {method: 'POST', body: JSON.stringify({...form, workId: data.workId})});
    setMeetingId(r.id); setStarting(false); reload();
  }
  async function decide() {
    setErr('');
    try {
      await request(`/props/items/${row.id}/versions`, {method: 'POST', body: JSON.stringify({...toBody({...versionInput(row), ...v}), baseVersionNo: row.versionNo, meetingId})});
      const k = queue.findIndex((r) => r.id === row.id);
      setCurrent(queue[k + 1]?.id ?? null);
      reload();
    } catch (x) { setErr(x.message || '保存できませんでした'); }
  }
  function skip() { const k = queue.findIndex((r) => r.id === row.id); setCurrent(queue[(k + 1) % queue.length]?.id ?? null); }
  if (starting || !meeting) {
    return canWrite ? <NewMeeting vocab={vocab} onCreate={start} onCancel={meetings.length ? () => setStarting(false) : null} /> : <p className="prp-sub">—</p>;
  }
  return (
    <>
      <div className="prp-bar">
        <select aria-label="打ち合わせの回" value={meetingId} onChange={(e) => setMeetingId(Number(e.target.value))}>
          {meetings.map((m) => <option key={m.id} value={m.id}>{md(m.heldOn)}　{m.title}</option>)}
        </select>
        <span className="prp-sub">{meeting.departments.map((d) => vocab.departments[d]).join('・')}</span>
        <span className="prp-fill" />
        {canWrite && <button type="button" onClick={() => setStarting(true)}>＋ 回</button>}
      </div>
      <div className="prp-meet">
        <div>
          <div className="prp-bar">
            <select aria-label="決める品目" value={all ? 'all' : 'open'} onChange={(e) => { setAll(e.target.value === 'all'); setCurrent(null); }}>
              <option value="open">未割当・要調整</option><option value="all">すべて</option>
            </select>
            <span className="prp-sub">{queue.length}</span>
          </div>
          <ul className="prp-queue" aria-label="決める品目">
            {queue.map((r) => (
              <li key={r.id} className={row && r.id === row.id ? 'on' : ''}><button type="button" onClick={() => setCurrent(r.id)}>
                <span>{r.sceneLabel || '—'}　{r.name}</span><span className="prp-sub"><span className="prp-tag">{vocab.states[r.state]}</span>　{md(r.shootOn)}</span>
              </button></li>
            ))}
            {!queue.length && <li className="prp-sub">—</li>}
          </ul>
        </div>
        {row ? (
          <div className="prp-card">
            <div className="prp-sub">{md(row.shootOn)}　{row.sceneLabel || ''}　{row.place || ''}　{vocab.kinds[row.kind]}</div>
            <div className="prp-name prp-big">{row.name}</div>
            {row.scriptNote && <div className="prp-script">{row.scriptNote}</div>}
            {row.memo && <div className="prp-sub">{row.memo}</div>}
            <div className="prp-form"><Fields v={v} set={setV} vocab={vocab} /></div>
            {canWrite && <div className="prp-act"><button type="button" className="on" onClick={decide}>決めた → 次へ</button><button type="button" onClick={skip}>後で</button>{err && <span className="prp-stop">{err}</span>}</div>}
          </div>
        ) : <div className="prp-card prp-sub">—</div>}
        <div>
          <h3 className="prp-h">この回で決めた {decisions.length}</h3>
          <ol className="prp-decided">
            {decisions.map((d) => (
              <li key={`${d.itemId}-${d.versionNo}`}><b>{d.sceneLabel ? `${d.sceneLabel}　` : ''}{d.name}</b>
                <div className="prp-sub">{d.department ? vocab.departments[d.department] : '—'}{d.ownerLabel ? `・${d.ownerLabel}` : ''} ／ {vocab.states[d.state]}{d.nextAction ? ` ／ ${d.nextAction}` : ''}{d.dueOn ? `（${md(d.dueOn)}）` : ''}</div></li>
            ))}
          </ol>
        </div>
      </div>
    </>
  );
}

// workId: 画面の上で選んでいる作品（URL の work）。あればその作品の小道具を開き、無ければ受け口が選ぶ最初の作品を開く
export default function Props({request, workId: selectedWorkId = null}) {
  const [workId, setWorkId] = useState(selectedWorkId);
  const [data, setData] = useState(null);
  const [err, setErr] = useState('');
  const [mode, setMode] = useState('list');
  const [reloadNo, setReloadNo] = useState(0);
  useEffect(() => {
    let alive = true;
    request(`/props${workId ? `?workId=${workId}` : ''}`).then((r) => alive && setData(r)).catch((e) => alive && setErr(e.message || '読み込めませんでした'));
    return () => { alive = false; };
  }, [request, workId, reloadNo]);
  const reload = useCallback(() => setReloadNo((n) => n + 1), []);
  if (!data) return <div className="prp"><p className="prp-sub">{err || '読み込み中'}</p></div>;
  const work = data.works.find((w) => w.id === data.workId);
  const counts = stateCounts(data.items);
  return (
    <div className="prp">
      <div className="prp-bar">
        <div className="prp-chips" role="group" aria-label="作品">
          {data.works.map((w) => <button type="button" key={w.id} className={w.id === data.workId ? 'on' : ''} onClick={() => setWorkId(w.id)}>{w.title}</button>)}
        </div>
        <span className="prp-fill" />
        {counts.open > 0 && <span className="prp-alert">! 要確認 {counts.open}</span>}
        <div className="prp-chips" role="group" aria-label="表示">
          <button type="button" className={mode === 'list' ? 'on' : ''} onClick={() => setMode('list')}>一覧</button>
          <button type="button" className={mode === 'meeting' ? 'on' : ''} onClick={() => setMode('meeting')}>打ち合わせ</button>
          <button type="button" className={mode === 'board' ? 'on' : ''} onClick={() => setMode('board')}>看板</button>
        </div>
      </div>
      {!work ? <p className="prp-sub">—</p>
        : mode === 'list' ? <ListMode data={data} request={request} reload={reload} canWrite={work.canWrite} />
          : mode === 'board' ? <PropsBoard key={data.workId} data={data} request={request} reload={reload} canWrite={work.canWrite} />
          : <MeetingMode key={data.workId} data={data} request={request} reload={reload} canWrite={work.canWrite} />}
    </div>
  );
}
