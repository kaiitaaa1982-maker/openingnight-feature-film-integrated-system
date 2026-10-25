// ロイヤリティ報告管理のフォルダ（会社ルート plans/2026-10-22-folder-royalty.md）。権利者への報告を最優先に、今月送る・支払月の合計・
// 権利者×締め月・権利者の推移を1画面に置く。額と状態は期間の一覧（GET /api/royalty/periods）を読むだけで、この画面のための表は持たない。
// 確定と報告の記録は既存の受け口（statements/generate・statements/:id/events）を呼ぶ。見た目は docs/design/integrated-system-visual.md。
import React, {useEffect, useMemo, useState} from 'react';
import {useShell} from '../shell/context.mjs';
import {yen, int, dateJst} from '../ui/format.mjs';
import {ErrorNotice} from './RoyaltyParts.jsx';
import {todayJst, isCreatablePeriod} from './royalty-ui.mjs';
import {fiscalMonths, fiscalYearOf, buildGrid, dueThisMonth, paymentMonthTotals, holderTrend, cellOf} from './royalty-folder-model.mjs';
import './royalty-folder.css';

const DEFAULT_FISCAL_START = 5;
// 札の見え方: 止まっている（期限超過）は赤、まだ先（受付中・後へ）は灰、ほかは黒
const tone = (status) => (status === 'overdue' ? 'is-stop' : status === 'open' || status === 'merged' ? 'is-faint' : '');
const ym = (m) => `${Number(m.slice(0, 4))}.${Number(m.slice(5, 7))}`;
const LEGEND = [['受', '受付'], ['作', '作成待'], ['超', '超過'], ['済', '確定'], ['報', '報告済'], ['払', '支払済'], ['後', '後へ'], ['–', '締めなし']];

function Tag({cell}) {
  return <span className={`rf-tag ${tone(cell.status)}`}>{cell.char}</span>;
}

function Cell({cell, onOpen}) {
  if (!cell) return <span className="rf-none" aria-label="締めなし">–</span>;
  return (
    <button type="button" className={`rf-cell ${tone(cell.status)}`} disabled={cell.period.restricted} onClick={() => onOpen(cell.period)}
      aria-label={`${cell.label}${cell.amount ? ` ${int(cell.amount.payableYen)}円${cell.amount.draft ? ' 下書き' : ''}` : ''}`}>
      <span className="rf-char">{cell.char}</span>
      {cell.amount && <span className={`rf-yen${cell.amount.draft ? ' is-draft' : ''}`}>{int(cell.amount.payableYen)}</span>}
    </button>
  );
}

function TrendChart({rows}) {
  const max = Math.max(1, ...rows.map((r) => Math.max(r.royaltyYen ?? 0, 0)));
  const maxCum = Math.max(1, ...rows.map((r) => r.cumulativeYen));
  const w = 40, h = 110;
  const points = rows.map((r, k) => `${k * w + w / 2},${h - (r.cumulativeYen / maxCum) * (h - 10)}`).join(' ');
  return (
    <svg className="rf-chart" viewBox={`0 0 ${Math.max(rows.length, 1) * w} ${h + 16}`} role="img" aria-label="当期と累計">
      {rows.map((r, k) => {
        const v = Math.max(r.royaltyYen ?? 0, 0), bh = (v / max) * (h - 10);
        const paid = r.paidYen !== null && r.payableYen > 0 && r.paidYen >= r.payableYen;
        return (
          <g key={r.closeMonth}>
            <rect x={k * w + 10} y={h - bh} width={w - 20} height={bh} className={`rf-bar${r.draft ? ' is-draft' : paid ? '' : ' is-open'}`} />
            <text x={k * w + w / 2} y={h + 12} textAnchor="middle" className="rf-axis">{ym(r.closeMonth)}</text>
          </g>
        );
      })}
      {rows.length > 1 && <polyline points={points} className="rf-line" />}
    </svg>
  );
}

export function RoyaltyFolderPage({onNavigate}) {
  const shell = useShell();
  const request = shell.request;
  const navigate = onNavigate || shell.navigate;
  const today = todayJst();
  const thisMonth = today.slice(0, 7);
  const [fiscalStart, setFiscalStart] = useState(DEFAULT_FISCAL_START);
  const fy = Number(shell.getParam('fy', String(fiscalYearOf(today, fiscalStart))));
  const holderId = shell.getParam('holder', '');
  const [state, setState] = useState({loading: true});
  const [revision, setRevision] = useState(0);
  const [busy, setBusy] = useState(null);
  const [confirming, setConfirming] = useState(false);
  const [message, setMessage] = useState(null);
  const [error, setError] = useState(null);
  const [reportedOn, setReportedOn] = useState(today);

  useEffect(() => {
    let live = true;
    request('/settings/fiscal').then((b) => live && b?.setting?.fiscalStartMonth && setFiscalStart(Number(b.setting.fiscalStartMonth))).catch(() => {});
    return () => { live = false; };
  }, [request]);

  useEffect(() => {
    let live = true;
    setState((previous) => ({...previous, loading: true, error: null}));
    request(`/royalty/periods?asOf=${today}`).then((body) => live && setState({body})).catch((cause) => live && setState({error: cause}));
    return () => { live = false; };
  }, [request, today, revision]);

  const periods = state.body?.periods || [];
  const months = useMemo(() => fiscalMonths(fy, fiscalStart), [fy, fiscalStart]);
  const grid = useMemo(() => buildGrid(periods, months), [periods, months]);
  const due = useMemo(() => dueThisMonth(periods, thisMonth), [periods, thisMonth]);
  const payments = useMemo(() => paymentMonthTotals(periods), [periods]);
  const trend = useMemo(() => (holderId ? holderTrend(periods, holderId) : []), [periods, holderId]);
  const creatable = due.rows.filter(isCreatablePeriod);
  const toReport = due.rows.filter((p) => p.statementId && !p.reportedOn);
  const holderName = (state.body?.holders || []).find((h) => String(h.id) === String(holderId))?.name;
  const readOnly = shell.readOnly;

  function open(period) {
    if (period.restricted) return;
    navigate('ロイヤリティ報告書', period.statementId ? {statement: String(period.statementId)} : {holder: String(period.holderId), close: period.closeMonth});
  }

  async function confirmAll() {
    setBusy('generate'); setError(null); setMessage(null);
    try {
      const keys = creatable.map((p) => p.key);
      const expectedHashes = Object.fromEntries(creatable.filter((p) => p.draft?.inputHash).map((p) => [p.key, p.draft.inputHash]));
      const r = await request('/royalty/statements/generate', {method: 'POST', body: JSON.stringify({asOf: today, keys, expectedHashes, confirmed: true})});
      const skipped = r.skipped?.length || 0;
      setMessage({stop: skipped > 0, text: `確定 ${int(r.created?.length || 0)}通${skipped ? `・止まった ${int(skipped)}通（行を開いて理由）` : ''}`});
      setRevision((n) => n + 1);
    } catch (cause) { setError(cause); }
    setConfirming(false);
    setBusy(null);
  }

  async function reportAll() {
    setBusy('report'); setError(null); setMessage(null);
    let done = 0;
    const failed = [];
    for (const p of toReport) {
      try {
        await request(`/royalty/statements/${p.statementId}/events`, {method: 'POST', body: JSON.stringify({kind: 'reported', occurredOn: reportedOn})});
        done += 1;
      } catch (cause) { failed.push(`${p.holderName} ${ym(p.closeMonth)}：${cause.message || '記録できません'}`); }
    }
    setMessage({stop: failed.length > 0, text: `報告日 ${dateJst(reportedOn)}・${int(done)}通`, details: failed});
    setRevision((n) => n + 1);
    setBusy(null);
  }

  return (
    <div className="rf">
      <h2>ロイヤリティ</h2>
      {state.error && <ErrorNotice error={state.error} />}
      {state.loading && !state.body && <p className="is-faint" aria-busy="true">読込中</p>}
      {state.body && !periods.length && (
        <div className="rf-actions"><span className="rf-tag is-faint">契約なし</span>
          <button type="button" className="rf-btn is-ghost" onClick={() => navigate('ロイヤリティ契約')}>契約</button></div>
      )}

      {state.body && periods.length > 0 && (
        <>
          <section className="rf-sec" aria-label="今月送る">
            <div className="rf-sec-head">
              <h3>今月送る</h3>
              {due.remaining ? <span className="rf-now">残 {int(due.remaining)}</span> : <span className="rf-done">済</span>}
            </div>
            {due.rows.length > 0 && (
              <table>
                <thead><tr><th>権利者</th><th>締め</th><th>期限</th><th>状態</th><th className="num">支払予定</th></tr></thead>
                <tbody>{due.rows.map((p) => {
                  const c = cellOf(p);
                  return (
                    <tr key={p.key} className="rf-click" onClick={() => open(p)}>
                      <td>{p.holderName}</td><td>{ym(p.closeMonth)}</td>
                      <td className={p.status === 'overdue' ? 'is-stop-text' : ''}>{dateJst(p.reportDueOn)}</td>
                      <td><Tag cell={c} /> {p.blockedReason && <span className="rf-tag is-stop">照合差</span>}</td>
                      <td className={`num${c.amount?.draft ? ' is-faint' : ''}`}>{c.amount ? yen(c.amount.payableYen) : '—'}</td>
                    </tr>
                  );
                })}</tbody>
              </table>
            )}
            {!readOnly && due.rows.length > 0 && (
              <div className="rf-actions">
                {!confirming
                  ? <button type="button" className="rf-btn" disabled={!creatable.length || Boolean(busy)} onClick={() => setConfirming(true)}>確定 {int(creatable.length)}通</button>
                  : <>
                    <span className="rf-msg">{int(creatable.length)}通を確定（確定後は変更不可）</span>
                    <button type="button" className="rf-btn" disabled={Boolean(busy)} onClick={confirmAll}>{busy === 'generate' ? '確定中' : '確定する'}</button>
                    <button type="button" className="rf-btn is-ghost" disabled={Boolean(busy)} onClick={() => setConfirming(false)}>やめる</button>
                  </>}
                <label>報告日<input type="date" value={reportedOn} max={today} onChange={(e) => setReportedOn(e.target.value || today)} /></label>
                <button type="button" className="rf-btn is-ghost" disabled={!toReport.length || Boolean(busy)} onClick={reportAll}>{busy === 'report' ? '記録中' : `記録 ${int(toReport.length)}通`}</button>
              </div>
            )}
            {message && <p className={`rf-msg${message.stop ? ' is-stop' : ''}`}>{message.text}{message.details?.map((d) => <span key={d} style={{display: 'block'}}>{d}</span>)}</p>}
            <ErrorNotice error={error} />
          </section>

          <section className="rf-sec" aria-label="支払月">
            <div className="rf-sec-head"><h3>支払月</h3></div>
            <table>
              <thead><tr><th>月</th><th className="num">通</th><th className="num">予定</th><th className="num">済</th><th className="num">未払</th><th className="num">下書</th></tr></thead>
              <tbody>{payments.map((r) => (
                <tr key={r.month}>
                  <td>{r.month === thisMonth ? <strong>{ym(r.month)}</strong> : ym(r.month)}</td><td className="num">{int(r.statements)}</td>
                  <td className="num">{yen(r.payableYen)}</td><td className="num">{yen(r.paidYen)}</td>
                  <td className={`num${r.unpaidYen > 0 && r.month < thisMonth ? ' is-stop-text' : ''}`}>{yen(r.unpaidYen)}</td>
                  <td className="num is-faint">{r.drafts ? yen(r.draftYen) : '—'}</td>
                </tr>
              ))}</tbody>
            </table>
          </section>

          <section className="rf-sec" aria-label="権利者×締め月">
            <div className="rf-sec-head">
              <h3>権利者</h3>
              <label>年度
                <select value={String(fy)} onChange={(e) => shell.setParam('fy', e.target.value || null)}>
                  {[fy - 1, fy, fy + 1].map((y) => <option key={y} value={String(y)}>{y}</option>)}
                </select>
              </label>
            </div>
            <div className="rf-scroll">
              <table className="rf-grid">
                <thead><tr><th>権利者</th>{grid.columns.map((m) => <th key={m}>{Number(m.slice(5))}月<small>{m.slice(0, 4)}</small></th>)}</tr></thead>
                <tbody>{grid.rows.map((row) => (
                  <tr key={row.holderId}>
                    <th><button type="button" className="rf-holder" aria-pressed={String(holderId) === String(row.holderId)}
                      onClick={() => shell.setParam('holder', String(holderId) === String(row.holderId) ? null : String(row.holderId))}>{row.holderName}</button></th>
                    {grid.columns.map((m) => <td key={m}><Cell cell={row.cells[m]} onOpen={open} /></td>)}
                  </tr>
                ))}</tbody>
              </table>
            </div>
            <ul className="rf-legend" aria-label="凡例">{LEGEND.map(([c, l]) => <li key={c}><span className={`rf-tag ${c === '超' ? 'is-stop' : c === '受' || c === '後' ? 'is-faint' : ''}`}>{c}</span>{l}</li>)}</ul>
          </section>

          {holderId && (
            <section className="rf-sec" aria-label="推移">
              <div className="rf-sec-head">
                <h3>{holderName || '権利者'}</h3>
                <button type="button" className="rf-btn is-ghost" onClick={() => shell.setParam('holder', null)}>閉じる</button>
              </div>
              {trend.length > 0 && <TrendChart rows={trend} />}
              <table>
                <thead><tr><th>締め</th><th>状態</th><th className="num">当期</th><th className="num">調整</th><th className="num">支払予定</th><th className="num">繰越</th><th className="num">支払済</th><th className="num">累計</th><th>報告日</th></tr></thead>
                <tbody>{trend.map((r) => (
                  <tr key={r.closeMonth} className={`rf-click${r.draft ? ' is-faint' : ''}`} onClick={() => open(r.period)}>
                    <td>{ym(r.closeMonth)}</td><td><Tag cell={r.cell} /></td>
                    <td className="num">{r.royaltyYen === null ? '—' : yen(r.royaltyYen)}</td><td className="num">{r.adjustmentYen === null ? '—' : yen(r.adjustmentYen)}</td>
                    <td className="num">{r.payableYen === null ? '—' : yen(r.payableYen)}</td><td className="num">{r.carriedOutYen === null ? '—' : yen(r.carriedOutYen)}</td>
                    <td className="num">{r.paidYen === null ? '—' : yen(r.paidYen)}</td><td className="num">{yen(r.cumulativeYen)}</td>
                    <td>{r.reportedOn ? dateJst(r.reportedOn) : '—'}</td>
                  </tr>
                ))}</tbody>
              </table>
            </section>
          )}
        </>
      )}
    </div>
  );
}

export default RoyaltyFolderPage;
