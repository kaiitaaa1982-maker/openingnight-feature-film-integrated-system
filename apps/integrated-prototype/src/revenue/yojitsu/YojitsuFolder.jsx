// 予実管理のフォルダの画面（会社ルートの plans/2026-10-22-folder-yojitsu.md の最初の一切れ。試作 4-prototype.html の形）。
// 年度を選ぶ → 12か月のマス（目・行・予・実の印）→ 月を開くと足りないものと締める・戻す。下に全体の4段（目標の行はその場で直す）と案件ごとの着地予測・実績。
// 値は GET /api/revenue/yojitsu/folder から読むだけで、計算は受け口がする。予実は入金に固定（D-039）
import React, {useCallback, useEffect, useState} from 'react';
import {Notice} from '../../ui/Notice.jsx';
import {ratioBps} from './money-yojitsu.mjs';
import './yojitsu-folder.css';

// 万円で小数1桁まで（表示だけ。値は受け口の整数の円のまま）
const man = (yen) => (yen == null ? '—' : (yen / 10000).toLocaleString('ja-JP', {maximumFractionDigits: 1}));
const pct = (bps) => (bps == null ? '—' : `${(bps - (bps % 100)) / 100}%`); // bp を整数の % に（切り捨て）
const monthLabel = (month) => `${Number(month.slice(5, 7))}月`;
// DB の時刻（UTC の 'YYYY-MM-DD HH:MM:SS'）を日本時間の 'YYYY-MM-DD HH:MM' に
const jst = (at) => { const d = new Date(`${String(at).replace(' ', 'T')}Z`); return Number.isNaN(d.getTime()) ? String(at).slice(0, 16) : new Date(d.getTime() + 9 * 3600 * 1000).toISOString().slice(0, 16).replace('T', ' '); };
const MARKS = [['target', '目'], ['action', '行'], ['forecast', '予'], ['actual', '実']];
const STATE_LABEL = {closed: '締済', current: '今月', future: '', missing: '不足', closable: '締可'};
const MARK_HELP = {
  target: {text: '年度の目標・計画の版が無い', page: null},
  action: {text: '結果欄が空の営業の活動', page: '商品・営業'},
  forecast: {text: '着地の案件なのに予測の版が無い', page: '企画・作品'},
  actual: {text: '請求額と違う入金（未確定）', page: '請求・入金'},
};

function Cell({cell, selected, onOpen}) {
  const label = cell.state === 'missing' ? `不足 ${cell.missing}` : STATE_LABEL[cell.state];
  return (
    <button type="button" className={`yf-cell is-${cell.state}${selected ? ' is-selected' : ''}`} disabled={cell.state === 'future'} onClick={() => onOpen(cell.month)}
      data-month={cell.key} data-state={cell.state}>
      <span className="yf-m">{monthLabel(cell.month)}</span><span className="yf-st">{label}</span>
      {cell.state !== 'future' && cell.state !== 'current' && <span className="yf-marks">
        {MARKS.map(([key, mark]) => <span key={key} className={`yf-mk${cell.marks[key] ? ' bad' : ''}`}>{mark}{cell.marks[key] ? ` ${cell.marks[key]}` : ''}</span>)}
      </span>}
    </button>
  );
}

function FourTable({folder, months, canWrite, onSaveTarget}) {
  const [editing, setEditing] = useState(false);
  const [amount, setAmount] = useState('');
  const [reason, setReason] = useState('');
  const closedIndex = folder.closedMonth ? months.findIndex((m) => m.month === folder.closedMonth) : -1;
  const row = (key) => folder.rows.find((r) => r.key === key);
  const target = row('target_self');
  const render = (r, cls, fmt) => r && <tr key={r.key} className={cls}>
    <td>{r.label}</td>
    {r.months.map((v, i) => <td key={i} className={`n${i === closedIndex ? ' yf-edge' : ''}`}>{r.hidden ? '—' : fmt(v)}</td>)}
    <td className="n">{r.hidden ? '—' : fmt(r.annual)}</td>
  </tr>;
  return (
    <div className="yf-card">
      <div className="yf-head"><h3>4段</h3><span className="yf-note">万円・{folder.basisLabel ?? '入金ベース固定'}</span></div>
      <div className="yf-wrap"><table className="yf-table">
        <thead><tr><th></th>{months.map((m, i) => <th key={m.key} className={`n${i === closedIndex ? ' yf-edge' : ''}`}>{monthLabel(m.month)}</th>)}<th className="n">年</th></tr></thead>
        <tbody>
          {target && <tr className={`main${canWrite ? ' yf-editable' : ''}`} onClick={() => { if (canWrite && !editing) { setEditing(true); setAmount(target.annual == null ? '' : String(target.annual)); } }}
            title={canWrite ? '押すと年度の目標を直せる' : undefined}>
            <td>目標（予算）{canWrite && <span className="yf-pen"> ✎</span>}</td>
            {target.months.map((v, i) => <td key={i} className={`n${i === closedIndex ? ' yf-edge' : ''}`}>{target.hidden ? '—' : man(v)}</td>)}
            <td className="n">{target.hidden ? '—' : man(target.annual)}</td>
          </tr>}
          {render(row('plan'), 'main', man)}
          {render(row('landing'), 'main', man)}
          {render(row('actual'), 'main', man)}
          {render(row('actual_rate'), 'rate', pct)}
          {render(row('actual_progress'), 'rate', pct)}
          {render(row('weighted'), 'sub', man)}
        </tbody>
      </table></div>
      {editing && <div className="yf-form">
        <label>年度の目標（本人・円・税別）<input inputMode="numeric" value={amount} onChange={(e) => setAmount(e.target.value.replace(/[^0-9]/g, ''))} /></label>
        <label>直す理由（任意）<input value={reason} onChange={(e) => setReason(e.target.value)} /></label>
        <button type="button" disabled={amount === ''} onClick={async () => { await onSaveTarget(Number(amount), reason); setEditing(false); setReason(''); }}>保存（新しい版）</button>
        <button type="button" className="secondary" onClick={() => setEditing(false)}>やめる</button>
      </div>}
    </div>
  );
}

function MonthPanel({folder, cell, canWrite, onClose, onReopen, onNavigate}) {
  const [reason, setReason] = useState('');
  useEffect(() => setReason(''), [cell?.month]);
  if (!cell) return null;
  const isLastClosed = cell.state === 'closed' && folder.closedMonth === cell.month;
  const missing = MARKS.filter(([key]) => cell.marks[key] > 0);
  return (
    <div className="yf-card yf-month" data-open-month={cell.key}>
      <p className={`yf-verdict is-${cell.state}`}>
        {cell.state === 'missing' ? <>不足 <b>{cell.missing}</b> <span className="yf-tag bad">{missing.map(([k, m]) => `${m} ${cell.marks[k]}`).join('・')}</span></>
          : cell.state === 'closable' ? '締可' : cell.state === 'closed' ? '締済' : cell.state === 'current' ? '今月' : ''}
      </p>
      {missing.length > 0 && <div className="yf-miss">
        {missing.map(([key, mark]) => <div key={key} className="yf-miss-item">
          <span><b>{mark}</b> {MARK_HELP[key].text} <b>{cell.marks[key]}</b>
            {key === 'forecast' && folder.details?.forecast?.length > 0 && <small>（{folder.details.forecast.map((p) => p.code).join('・')}）</small>}
            {key === 'target' && <small>（{(folder.details?.target ?? []).join('・')}）</small>}</span>
          {MARK_HELP[key].page && onNavigate && <button type="button" className="secondary" onClick={() => onNavigate(MARK_HELP[key].page)}>{MARK_HELP[key].page}へ</button>}
        </div>)}
      </div>}
      {canWrite && (cell.state === 'missing' || cell.state === 'closable') && <div className="yf-form">
        {cell.state === 'missing' && <label>足りないまま締める理由（必須）<input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="例: 取引先の入金が来月にずれる" /></label>}
        <button type="button" disabled={cell.state === 'missing' && !reason.trim()} onClick={() => onClose(cell, reason)}>締める</button>
      </div>}
      {canWrite && isLastClosed && <div className="yf-form">
        <label>締めを戻す理由（必須）<input value={reason} onChange={(e) => setReason(e.target.value)} /></label>
        <button type="button" className="secondary" disabled={!reason.trim()} onClick={() => onReopen(reason)}>戻す</button>
      </div>}
    </div>
  );
}

export default function YojitsuFolder({request, onNavigate}) {
  const [year, setYear] = useState(null);
  const [data, setData] = useState(null);
  const [closes, setCloses] = useState([]);
  const [open, setOpen] = useState(null);
  const [project, setProject] = useState(null);
  const [error, setError] = useState(null);
  const [message, setMessage] = useState('');
  const [firstMonth, setFirstMonth] = useState('2026-11');

  const load = useCallback(async (y = year) => {
    setError(null);
    try {
      const body = await request(`/revenue/yojitsu/folder${y ? `?year=${y}` : ''}`);
      setData(body);
      if (body.folder && y == null) setYear(body.folder.period.yearNo);
      setCloses((await request('/revenue/yojitsu/folder/closes')).closes ?? []);
    } catch (failure) { setError(failure); }
  }, [request, year]);
  useEffect(() => { load(year); }, [year]); // eslint-disable-line react-hooks/exhaustive-deps

  const act = async (fn, done) => {
    setError(null); setMessage('');
    try { await fn(); setMessage(done); await load(year); } catch (failure) { setError(failure); }
  };

  if (error && !data) return <Notice error={error} />;
  if (!data) return <p aria-busy="true">読込中…</p>;
  if (!data.folder) {
    return (
      <section className="yf">
        <h2>予実管理</h2>
        <p>年度なし</p>
        {data.canWrite ? <div className="yf-form">
          <label>始まりの月<input type="month" value={firstMonth} onChange={(e) => setFirstMonth(e.target.value)} /></label>
          <button type="button" onClick={() => act(() => request('/revenue/yojitsu/folder/periods', {method: 'POST', body: {firstMonth}}), '年度を作りました')}>年度を作る</button>
        </div> : <p className="yf-note">年度を作れるのは管理者だけです。</p>}
        {error && <Notice error={error} />}
      </section>
    );
  }
  const folder = {...data.folder, basisLabel: data.basisLabel};
  const months = folder.months;
  const cell = months.find((m) => m.month === open) ?? null;
  const target = folder.rows.find((r) => r.key === 'target_self');
  const actual = folder.rows.find((r) => r.key === 'actual');
  const landing = folder.rows.find((r) => r.key === 'landing');
  const closedIdx = folder.closedMonth ? months.findIndex((m) => m.month === folder.closedMonth) : -1;
  const sumTo = (r, idx) => (r && idx >= 0 ? r.months.slice(0, idx + 1).reduce((a, v) => (v == null ? a : (a ?? 0) + v), null) : null);
  const targetToDate = sumTo(target, closedIdx);
  const actualToDate = sumTo(actual, closedIdx);
  const selectedProject = folder.projects.find((p) => p.projectId === project) ?? null;

  return (
    <section className="yf" data-ready={data.today}>
      <div className="yf-title">
        <h2>予実管理 › {folder.period.label}</h2>
        <select value={year ?? ''} onChange={(e) => { setYear(Number(e.target.value)); setOpen(null); setProject(null); }} aria-label="年度">
          {data.periods.map((p) => <option key={p.yearNo} value={p.yearNo}>{p.label}</option>)}
        </select>
        <span className="yf-note">期間 {folder.period.startsOn.slice(0, 7)}〜{folder.period.lastMonth.slice(0, 7)}。基準 入金。締めた月 {folder.closedMonth ? monthLabel(folder.closedMonth) : 'なし'}</span>
      </div>
      {message && <Notice tone="success" message={message} />}
      {error && <Notice error={error} />}

      <div className="yf-kpis">
        <div><span>目標（年）</span><b>{man(target?.annual)}</b><small>万円</small></div>
        <div><span>実績（締めた月まで）</span><b>{man(actualToDate)}</b><small>達成率 {targetToDate && actualToDate != null ? pct(ratioBps(actualToDate, targetToDate)) : '—'}</small></div>
        <div><span>着地予測（年）</span><b>{man(landing?.annual)}</b></div>
        <div><span>着地 − 目標</span><b>{landing?.annual == null || target?.annual == null ? '—' : man(landing.annual - target.annual)}</b><small>万円</small></div>
      </div>

      <div className="yf-card">
        <div className="yf-head"><h3>12か月</h3><span className="yf-note">目＝目標 行＝行動 予＝予測 実＝実績</span></div>
        <div className="yf-grid">{months.map((m) => <Cell key={m.key} cell={m} selected={open === m.month} onOpen={(month) => setOpen(open === month ? null : month)} />)}</div>
      </div>

      <MonthPanel folder={folder} cell={cell} canWrite={data.canWrite} onNavigate={onNavigate}
        onClose={(c, reason) => act(() => request('/revenue/yojitsu/folder/close', {method: 'POST', body: {month: c.key, previousVersionNo: folder.closedVersionNo, reason}}), `${monthLabel(c.month)}を締めました`)}
        onReopen={(reason) => act(() => request('/revenue/yojitsu/folder/reopen', {method: 'POST', body: {previousVersionNo: folder.closedVersionNo, reason}}), '締めを1か月戻しました')} />

      <FourTable folder={folder} months={months} canWrite={data.canWrite}
        onSaveTarget={(amountYen, reason) => act(() => request('/revenue/yojitsu/folder/target', {method: 'POST', body: {year, amountYen, previousVersionNo: folder.targetVersionNo, reason}}), '目標を新しい版で保存しました')} />

      <div className="yf-card">
        <div className="yf-head"><h3>案件</h3></div>
        <div className="yf-wrap"><table className="yf-table">
          <thead><tr><th>案件</th><th>段階（確度）</th><th className="n">着地予測（年）</th><th className="n">確度加重</th><th className="n">実績（年）</th></tr></thead>
          <tbody>{folder.projects.map((p) => <tr key={p.projectId} className={`yf-row${project === p.projectId ? ' is-selected' : ''}`} onClick={() => setProject(project === p.projectId ? null : p.projectId)}>
            <td>{p.code} {p.title}</td><td>{p.stageCode ?? '—'}{p.probabilityBps == null ? '' : `（${p.probabilityBps / 10000}）`}</td>
            <td className="n">{man(p.landing.annual)}</td><td className="n">{man(p.weighted.annual)}</td><td className="n">{man(p.actual.annual)}</td>
          </tr>)}</tbody>
        </table></div>
        {selectedProject && <div className="yf-wrap"><table className="yf-table yf-project">
          <thead><tr><th>{selectedProject.code}</th>{months.map((m) => <th key={m.key} className="n">{monthLabel(m.month)}</th>)}<th className="n">年</th></tr></thead>
          <tbody>
            {[['着地予測', selectedProject.landing, 'main'], ['確度加重', selectedProject.weighted, 'sub'], ['実績', selectedProject.actual, 'main']].map(([label, r, cls]) =>
              <tr key={label} className={cls}><td>{label}</td>{r.months.map((v, i) => <td key={i} className="n">{man(v)}</td>)}<td className="n">{man(r.annual)}</td></tr>)}
          </tbody>
        </table></div>}
      </div>

      {closes.length > 0 && <div className="yf-card">
        <h3>締めの記録</h3>
        <ul className="yf-log">{closes.map((c) => <li key={c.versionNo}><b>版{c.versionNo}</b> 締めた月 {c.closedMonth?.slice(0, 7)} <small>{c.basis ?? ''}{c.createdAt ? `（${jst(c.createdAt)}）` : ''}</small></li>)}</ul>
      </div>}

      {data.notes?.length > 0 && <details className="yf-notes"><summary>注記 {data.notes.length}</summary><ul>{data.notes.map((n) => <li key={n.code}>{n.text}</li>)}</ul></details>}
    </section>
  );
}
