// 解禁月のページ（営業管理。会社ルートの plans/2026-10-22-folder-eigyo.md の問い9 A）。
// 行＝その月に始まる窓口を持つ作品、列＝流通のまとまり6つ。マスに解禁日・窓口の数・提案先の数と状態の札（採用・提案中・急・—）。急（解禁まで30日以内で提案なし）だけ赤で、理由は札の title に出す。
// マスを押すと、その作品の提案の振り返り（view=proposals）へ移る。月と基準日は URL に残る（lmmonth・lmasof）。
import React, {useEffect, useRef, useState} from 'react';
import {useShell} from '../../shell/context.mjs';
import {Notice} from '../../ui/Notice.jsx';
import {todayJst} from '../partner-list-model.mjs';
import './proposals.css';

const STATE_LABEL = {done: '採用', proposed: '提案中', urgent: '急', none: '—'};
const STATE_TITLE = {done: '採用あり', proposed: '提案あり（採用なし）', urgent: '解禁まで30日以内で提案なし', none: '提案なし'};

export function LaunchMonth({request: requestProp}) {
  const shell = useShell();
  const requestRef = useRef(null);
  requestRef.current = requestProp || shell.request;
  const today = todayJst();
  const asOf = shell.getParam('lmasof', today) || today;
  const month = shell.getParam('lmmonth', asOf.slice(0, 7)) || asOf.slice(0, 7);
  const [state, setState] = useState({loading: true});

  useEffect(() => {
    let live = true;
    setState((previous) => ({...previous, loading: true, error: null}));
    requestRef.current(`/sales-launch-month?month=${encodeURIComponent(month)}&asOf=${encodeURIComponent(asOf)}`)
      .then((body) => { if (live) setState({body}); })
      .catch((error) => { if (live) setState({error}); });
    return () => { live = false; };
  }, [month, asOf]);

  const body = state.body;
  const shift = (delta) => {
    const [y, m] = month.split('-').map(Number);
    const d = new Date(Date.UTC(y, m - 1 + delta, 1));
    shell.setParam('lmmonth', d.toISOString().slice(0, 7), {replace: true});
  };
  const openProposals = (workId) => {
    shell.setParam('spwork', String(workId), {replace: true});
    shell.setParam('view', 'proposals', {replace: false});
  };

  return (
    <section className="card sp-page" aria-label="解禁月のページ">
      <header className="sp-head">
        <h2>{month.replace('-', '年')}月解禁</h2>
        <div className="sp-month" role="group" aria-label="月を選ぶ">
          <button type="button" onClick={() => shift(-1)} aria-label="前の月">◀</button>
          <input type="month" aria-label="月" value={month} onChange={(event) => event.target.value && shell.setParam('lmmonth', event.target.value, {replace: true})} />
          <button type="button" onClick={() => shift(1)} aria-label="次の月">▶</button>
        </div>
        <label className="sp-asof">基準日 <input type="date" value={asOf} onChange={(event) => shell.setParam('lmasof', event.target.value && event.target.value !== today ? event.target.value : null, {replace: true})} /></label>
      </header>
      {state.error && <Notice error={state.error} />}
      {state.loading && !body && <p className="rp-muted" aria-busy="true">読み込み中…</p>}
      {body && (
        <>
          <p className="sp-summary" aria-live="polite">{body.summary.works}作品・提案 {body.summary.proposals}件{body.summary.urgent ? <strong className="sp-bad">・急 {body.summary.urgent}</strong> : null}</p>
          {!body.rows.length ? <p className="rp-muted">0作品</p> : (
            <div className="sp-scroll">
              <table className="sp-grid" aria-label={`${month} 解禁の作品と流通ごとの提案`}>
                <thead><tr><th scope="col">作品</th>{body.groups.map((group) => <th scope="col" key={group.key}>{group.label}</th>)}</tr></thead>
                <tbody>
                  {body.rows.map((row) => (
                    <tr key={row.workId}>
                      <th scope="row" className="sp-work">{row.code} {row.title}</th>
                      {body.groups.map((group) => {
                        const cell = row.cells[group.key];
                        if (!cell) return <td key={group.key} className="sp-empty" />;
                        return (
                          <td key={group.key} className={`sp-cell sp-${cell.state}`}>
                            <button type="button" onClick={() => openProposals(row.workId)} title={`${STATE_TITLE[cell.state]}・${cell.windows.map((w) => w.typeLabel).join('・')}`}>
                              <span className="sp-date">{cell.earliestDay ? `${Number(month.slice(5))}/${cell.earliestDay}` : '月内'}・{cell.typeCount}種</span>
                              <span className="sp-state">{cell.partnerCount}社 {STATE_LABEL[cell.state]}</span>
                            </button>
                          </td>
                        );
                      })}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </section>
  );
}

export default LaunchMonth;
