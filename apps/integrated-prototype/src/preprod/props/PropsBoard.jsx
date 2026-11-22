// 小道具の「看板」（画面「小道具」の3つ目の表示。要件 docs/requirements/production/props-board.md）。
// 上に担当ごとの件数、下に5状態の列。状態の変更は既存の版の受け口（POST /api/props/items/:id/versions・baseVersionNo）で、
// ドラッグに頼らずカードの選択で変える。書けない人には選択を出さない。件数だけを出し、順位・％は出さない。
import React, {useMemo, useState} from 'react';
import {NO_DATE, boardColumns, canMoveTo, moveBody, ownerNames, ownerSummary, shootDates} from './props-board-model.mjs';

const md = (d) => (d ? `${Number(d.slice(5, 7))}/${Number(d.slice(8, 10))}` : '');
const daysUntil = (date, today) => Math.round((Date.parse(`${date}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / 86400000);
const todayJst = () => new Date(Date.now() + 9 * 3600000).toISOString().slice(0, 10);

function Card({row, vocab, canWrite, onMove}) {
  const [busy, setBusy] = useState(false);
  const owner = row.ownerLabel || (row.department ? vocab.departments[row.department] : '未定');
  return (
    <article className={`prb-card${row.state === 'unneeded' ? ' prb-off' : ''}`} aria-label={row.name}>
      <b>{row.name}</b>
      <div className="prp-sub">{[row.sceneLabel, md(row.shootOn), row.quantity].filter(Boolean).join('　') || '—'}</div>
      <div className="prp-sub">{owner}</div>
      {canWrite && (
        <select aria-label={`${row.name}の状態`} value={row.state} disabled={busy}
          onChange={async (e) => { setBusy(true); try { await onMove(row, e.target.value); } finally { setBusy(false); } }}>
          {Object.entries(vocab.states).map(([k, l]) => <option key={k} value={k} disabled={!canMoveTo(row, k)}>{l}</option>)}
        </select>
      )}
    </article>
  );
}

export default function PropsBoard({data, request, reload, canWrite}) {
  const {items, vocab} = data;
  const [shootOn, setShootOn] = useState('');
  const [owner, setOwner] = useState('');
  const [err, setErr] = useState('');
  const today = todayJst();
  const {dates, hasNone} = useMemo(() => shootDates(items), [items]);
  const manyYears = new Set(dates.map((d) => d.slice(0, 4))).size > 1;
  const owners = useMemo(() => ownerNames(items), [items]);
  const summary = useMemo(() => ownerSummary(items, {shootOn}), [items, shootOn]);
  const columns = useMemo(() => boardColumns(items, {shootOn, owner}), [items, shootOn, owner]);
  async function move(row, state) {
    setErr('');
    try { await request(`/props/items/${row.id}/versions`, {method: 'POST', body: JSON.stringify(moveBody(row, state))}); } catch (x) { setErr(x.message || '変えられませんでした'); }
    reload();
  }
  return (
    <div className="prb">
      <div className="prp-bar">
        <select aria-label="撮影日" value={shootOn} onChange={(e) => setShootOn(e.target.value)}>
          <option value="">撮影日</option>
          {dates.map((d) => { const n = daysUntil(d, today); return <option key={d} value={d}>{manyYears ? `${d.slice(0, 4)}/` : ''}{md(d)}{n >= 0 ? `（あと${n}日）` : ''}</option>; })}
          {hasNone && <option value={NO_DATE}>日付なし</option>}
        </select>
        <select aria-label="担当" value={owner} onChange={(e) => setOwner(e.target.value)}>
          <option value="">担当</option>
          {owners.map((o) => <option key={o} value={o}>{o}</option>)}
        </select>
        {err && <span className="prp-stop">{err}</span>}
      </div>
      <div className="prp-scroll">
        <table className="prb-sum" aria-label="担当ごとの件数">
          <thead><tr><th>担当</th><th className="prp-num">全件</th><th className="prp-num">用意済み</th><th className="prp-num">手配中</th><th className="prp-num">要調整</th><th className="prp-num">未割当</th><th className="prp-num">不要</th><th className="prp-num">残り</th></tr></thead>
          <tbody>{summary.map((n) => (
            <tr key={n.owner} className={owner === n.owner ? 'prp-sel' : ''} onClick={() => setOwner(owner === n.owner ? '' : n.owner)}>
              <td><button type="button" className="prb-link" aria-pressed={owner === n.owner}>{n.owner}</button></td>
              <td className="prp-num">{n.total}</td><td className="prp-num">{n.ready}</td><td className="prp-num">{n.arranging}</td><td className="prp-num">{n.adjust}</td>
              <td className="prp-num">{n.unassigned}</td><td className="prp-num">{n.unneeded}</td><td className="prp-num"><b>{n.remaining}</b></td>
            </tr>
          ))}</tbody>
        </table>
      </div>
      <div className="prb-board">
        {columns.map((c) => (
          <section key={c.id} className="prb-col" aria-label={c.label}>
            <h3>{c.label}<span className="prp-num">{c.cards.length}</span></h3>
            {c.cards.map((row) => <Card key={row.id} row={row} vocab={vocab} canWrite={canWrite} onMove={move} />)}
          </section>
        ))}
      </div>
    </div>
  );
}
