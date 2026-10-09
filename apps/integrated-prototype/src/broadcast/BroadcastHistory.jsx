// 番販・放送の「放送履歴表」タブ（全作品×年月）。定型業務の放送ウィンドウ管理表と同じ意味の表を、放送枠と実放送から出す。
// - 条件（期間・作品・局・同じ月に別の局があるものだけ）は URL（bhfrom・bhto・bhq・bhst・bhov）に残す
// - セルは局名（未確定は放送枠の状態の注記、実放送は「×回数」）。同じ月の別局は確定同士＝赤、未確定を含む＝黄（色と文字の両方で示す）
// - 画面は120作品まで。打ち切った件数を必ず出し、Excel は全件を出す
// - セルを押すと、その作品の「放送枠」タブをその月で開く
// - 上に「放送アベイルズリストを作る」（作品名の貼り付け → 照合 → 選択・並べ替え → Excel）
import React, {useCallback, useEffect, useMemo, useState} from 'react';
import {useShell} from '../shell/context.mjs';
import {Notice} from '../ui/Notice.jsx';
import {HISTORY_PARAMS, defaultHistoryRange, todayYmJst} from './broadcast-history-model.mjs';
import {ymText} from './intervals.mjs';
import {AvailsListPanel} from './AvailsListPanel.jsx';
import './broadcast-windows.css';

const COLOR_TEXT = {red: '競合：確定同士の別局', yellow: '注意：申請中・仮押さえの別局'};

function useParam(shell, key, fallback = '') {
  const value = shell.getParam(key, null) ?? fallback;
  const set = (next) => shell.setParam(key, next === null || next === undefined || next === '' || next === fallback ? null : String(next), {replace: true});
  return [value, set];
}

export function BroadcastHistory({request, onOpenSlots}) {
  const shell = useShell();
  const range = useMemo(() => defaultHistoryRange(todayYmJst()), []);
  const [from, setFrom] = useParam(shell, HISTORY_PARAMS.from, range.from);
  const [to, setTo] = useParam(shell, HISTORY_PARAMS.to, range.to);
  const [q, setQ] = useParam(shell, HISTORY_PARAMS.q, '');
  const [station, setStation] = useParam(shell, HISTORY_PARAMS.station, '');
  const [overlaps, setOverlaps] = useParam(shell, HISTORY_PARAMS.overlaps, '');
  const [query, setQuery] = useState(q);
  const [state, setState] = useState({loading: true});
  const [picked, setPicked] = useState(null);
  const params = useMemo(() => {
    const p = new URLSearchParams({from, to});
    if (q) p.set('q', q);
    if (station) p.set('station', station);
    if (overlaps) p.set('overlaps', '1');
    return p.toString();
  }, [from, to, q, station, overlaps]);
  const load = useCallback(async () => {
    setState((s) => ({...s, loading: true}));
    try { setState({body: await request(`/broadcast/history?${params}`)}); } catch (error) { setState({error}); }
  }, [request, params]);
  useEffect(() => { load(); }, [load]);
  useEffect(() => { setQuery(q); }, [q]);
  const body = state.body;

  return (
    <div className="bw-stack">
      <AvailsListPanel request={request} currentWorks={(body?.rows || []).map((row) => ({id: row.work_id, code: row.work_code, title: row.work_title}))} picked={picked} onPicked={() => setPicked(null)} />
      <section className="card rp-report" aria-label="放送履歴表">
        <header className="rp-head">
          <div>
            <h3>放送履歴表（全作品×年月）</h3>
            <p className="rp-muted">放送枠と実放送の記録から、作品ごとに月の放送局を並べます。セルを押すと、その作品の放送枠をその月で開きます。この表は読むだけで、登録は放送枠のタブで行います。</p>
          </div>
          <div className="bc-action-buttons">
            <a className="bc-link-button" href={`/api/broadcast/history/export.xlsx?${params}`} download>Excelで出力（全件）</a>
            <button type="button" className="secondary" onClick={load}>再読込</button>
          </div>
        </header>
        <form className="bw-filters" role="search" aria-label="放送履歴表の条件" onSubmit={(event) => { event.preventDefault(); setQ(query.trim()); }}>
          <label>開始月<input type="month" value={from} onChange={(event) => event.target.value && setFrom(event.target.value)} /></label>
          <label>終了月<input type="month" value={to} onChange={(event) => event.target.value && setTo(event.target.value)} /></label>
          <label>作品名・作品コード<input type="search" value={query} onChange={(event) => setQuery(event.target.value)} onBlur={() => setQ(query.trim())} placeholder="全角・半角を区別しません" /></label>
          <label>放送局
            <select value={station} onChange={(event) => setStation(event.target.value)}>
              <option value="">すべての局</option>
              {(body?.stations || []).map((s) => <option key={s.key} value={s.label}>{s.label}（{s.count}枠）</option>)}
              {station && !(body?.stations || []).some((s) => s.label === station) && <option value={station}>{station}</option>}
            </select>
          </label>
          <label className="bw-check"><input type="checkbox" checked={Boolean(overlaps)} onChange={(event) => setOverlaps(event.target.checked ? '1' : '')} />同じ月に別の局があるものだけ</label>
          <button type="submit" className="secondary">絞り込む</button>
          <button type="button" className="secondary" onClick={() => { setFrom(range.from); setTo(range.to); setQ(''); setQuery(''); setStation(''); setOverlaps(''); }}>既定に戻す</button>
        </form>
        <p className="bw-legend" aria-label="色と注記の意味">
          <span className="bw-cell is-red">赤</span>確定同士で同じ月に別の局　<span className="bw-cell is-yellow">黄</span>申請中・仮押さえを含む同じ月の別の局
          注記は放送枠の状態（下書き・一次承認待ち・仮押さえ・最終承認待ち・差し戻し）。×回数は実放送。中止の枠は出しません（実放送を記録した中止の枠は「（中止）×回数」）。
        </p>
        {state.error && <Notice error={state.error} onRetry={load} />}
        {body && body.truncated > 0 && (
          <Notice tone="warn" title={`${body.limit}作品までを表示しています（ほかに${body.truncated}作品・全${body.total}作品）`}
            message="作品名・局・「同じ月に別の局があるものだけ」で絞るか、Excel で全件を出してください。" />
        )}
        {body && (
          <p className="rp-muted" role="status">{ymText(body.filters.from)}〜{ymText(body.filters.to)}・{body.total}作品（赤 {body.counts.red}・黄 {body.counts.yellow}）</p>
        )}
        {state.loading && !body && <p className="rp-muted">読み込み中…</p>}
        {body && (
          <div className="bw-scroll" tabIndex={0} aria-label="放送履歴表（横にスクロールできます）">
            <table className="bw-matrix">
              <caption className="bw-sr">作品ごとの月別の放送局。セルを押すとその作品の放送枠を開きます</caption>
              <thead>
                <tr>
                  <th scope="col" className="bw-sticky bw-work">作品</th>
                  <th scope="col">放送解禁の期間</th>
                  <th scope="col">枠数・実放送</th>
                  {body.months.map((ym) => <th scope="col" key={ym} className="bw-month">{ymText(ym)}</th>)}
                </tr>
              </thead>
              <tbody>
                {body.rows.map((row) => (
                  <tr key={row.work_id}>
                    <th scope="row" className="bw-sticky bw-work">
                      <span>{row.work_title}</span>
                      <small>{row.work_code}{row.product_skus ? `｜${row.product_skus}` : ''}</small>
                      <button type="button" className="bw-mini" onClick={() => setPicked({id: row.work_id, code: row.work_code, title: row.work_title})}>リストに入れる</button>
                    </th>
                    <td className="bw-note">{row.release_window}</td>
                    <td className="bw-note">{row.slot_count}枠・{row.aired_runs}回{row.first_month ? `（初回 ${ymText(row.first_month)}）` : ''}</td>
                    {body.months.map((ym) => {
                      const cell = row.cells[ym];
                      if (!cell) return <td key={ym} className="bw-empty" aria-label={`${row.work_title} ${ymText(ym)}：放送枠なし`} />;
                      const label = `${row.work_title} ${ymText(ym)}：${cell.text}${cell.color ? `（${COLOR_TEXT[cell.color]}）` : ''}`;
                      return (
                        <td key={ym} className={cell.color ? `is-${cell.color}` : ''}>
                          <button type="button" className="bw-cell-button" aria-label={label} title={label} onClick={() => onOpenSlots?.(row.work_id, ym)}>
                            {cell.color && <span className="bw-flag" aria-hidden="true">{cell.color === 'red' ? '競合' : '注意'}</span>}
                            {cell.text}
                          </button>
                        </td>
                      );
                    })}
                  </tr>
                ))}
                {!body.rows.length && <tr><td colSpan={3 + body.months.length}>条件に合う作品はありません。</td></tr>}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}

export default BroadcastHistory;
