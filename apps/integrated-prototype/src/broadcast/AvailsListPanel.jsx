// 放送アベイルズリストを作る（放送履歴表のタブの上）。定型業務の手順と同じく
// ① 作品名を1行に1つ貼り付けて照合（一致・候補が複数・見つからない）→ ② 候補から選ぶ・外す → ③ 行の順を並べ替え → Excel。
// 放送局は選ばない（作品ごとに直近の局を自動で最大3局）。0件では出力しない（全作品に落とさない）。
// 名前に注意: 「販売条件の一覧」（/api/broadcast/avails）とは別物。
import React, {useEffect, useId, useRef, useState} from 'react';
import {Notice} from '../ui/Notice.jsx';
import {MATCH_STATES, MATCH_LEVELS, AVAILS_LINE_LIMIT, autoPickRows, needsConfirm, addToSelection, availsMatchText} from './avails-list-model.mjs';
import {todayJst} from '../sales-ops/partner-list-model.mjs';

const TONE = {matched: 'is-ok', ambiguous: 'is-warn', not_found: 'is-bad'};

export function AvailsListPanel({request, currentWorks = [], picked, onPicked}) {
  const textId = useId();
  const [text, setText] = useState('');
  const [result, setResult] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [selection, setSelection] = useState([]);
  const [choice, setChoice] = useState({});
  const [asOf, setAsOf] = useState(todayJst());
  const [open, setOpen] = useState(false);
  // 照合の応答が返ったときの選択（入れた件数を案内に出すため。照合の最中の「入れる」「外す」も反映した後の値）
  const selectionRef = useRef(selection);
  useEffect(() => { selectionRef.current = selection; }, [selection]);
  const add = (works) => setSelection((current) => addToSelection(current, works).next);
  useEffect(() => { if (picked) { add([picked]); setOpen(true); onPicked?.(); } }, [picked]); // eslint-disable-line react-hooks/exhaustive-deps

  async function match(event) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const body = await request('/broadcast/availability-list/match', {method: 'POST', body: JSON.stringify({text})});
      const autoAdded = addToSelection(selectionRef.current, autoPickRows(body.rows));
      setSelection(autoAdded.next);
      setResult({...body, autoAdded});
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  }
  const move = (index, delta) => setSelection((current) => {
    const next = [...current];
    const target = index + delta;
    if (target < 0 || target >= next.length) return current;
    [next[index], next[target]] = [next[target], next[index]];
    return next;
  });
  const href = `/api/broadcast/availability-list/export.xlsx?${new URLSearchParams({asOf, workIds: selection.map((w) => w.id).join(',')})}`;

  return (
    <details className="card bw-avails" open={open} onToggle={(event) => setOpen(event.currentTarget.open)}>
      <summary><strong>放送アベイルズリストを作る</strong><span className="rp-muted">（作品名の貼り付け → 照合 → 選んだ順に Excel。局は直近の3局を自動で出します）</span></summary>
      <form className="bw-avails-form" onSubmit={match} aria-label="作品名の照合">
        <label htmlFor={textId}>作品名・作品コード・品番を1行に1つ（{AVAILS_LINE_LIMIT}行まで）</label>
        <textarea id={textId} rows={5} value={text} onChange={(event) => setText(event.target.value)} placeholder={'夜明けの貨物線（架空）\nDEMO-W02'} />
        <div className="bc-action-buttons">
          <button type="submit" disabled={busy || !text.trim()}>{busy ? '照合しています…' : '照合する'}</button>
          <button type="button" className="secondary" disabled={!currentWorks.length} onClick={() => add(currentWorks)}>放送履歴表に出ている作品をすべて入れる（{currentWorks.length}件）</button>
        </div>
      </form>
      {error && <Notice error={error} onDismiss={() => setError(null)} />}
      {result && (
        <div className="bw-match">
          <p role="status" className="rp-muted">{availsMatchText(result, result.autoAdded)}</p>
          <table className="bw-table" aria-label="照合の結果">
            <thead><tr><th scope="col">行</th><th scope="col">貼り付けた文字</th><th scope="col">結果</th><th scope="col">選ぶ</th></tr></thead>
            <tbody>
              {result.rows.map((row) => (
                <tr key={row.lineNo}>
                  <td>{row.lineNo}</td>
                  <td>{row.input}</td>
                  <td><span className={`bc-flag ${needsConfirm(row) ? 'is-warn' : TONE[row.status]}`}>{MATCH_STATES[row.status]}{row.status === 'matched' && row.level && row.level !== 'exact' ? `（${MATCH_LEVELS[row.level]}）` : ''}</span></td>
                  <td>
                    {row.status === 'matched' && !needsConfirm(row) && `${row.candidates[0].title}（${row.candidates[0].code}）`}
                    {needsConfirm(row) && (
                      <span className="bc-action-buttons">
                        <span>{row.candidates[0].title}（{row.candidates[0].code}）</span>
                        <button type="button" className="secondary" onClick={() => add([row.candidates[0]])}>入れる</button>
                      </span>
                    )}
                    {row.status === 'ambiguous' && (
                      <span className="bc-action-buttons">
                        <select aria-label={`${row.input}の候補`} value={choice[row.lineNo] ?? ''} onChange={(event) => setChoice((c) => ({...c, [row.lineNo]: event.target.value}))}>
                          <option value="">候補から選ぶ（{row.candidates.length}件{row.more ? `・ほか${row.more}件` : ''}）</option>
                          {row.candidates.map((c) => <option key={c.id} value={c.id}>{c.title}（{c.code}{c.production_year ? `・${c.production_year}年` : ''}）</option>)}
                        </select>
                        <button type="button" className="secondary" disabled={!choice[row.lineNo]} onClick={() => add([row.candidates.find((c) => String(c.id) === String(choice[row.lineNo]))])}>入れる</button>
                      </span>
                    )}
                    {row.status === 'not_found' && <span className="rp-muted">見つかりません。表記を変えてもう一度照合してください</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <section className="bw-selection" aria-label="リストに入れる作品">
        <h4>リストに入れる作品（{selection.length}件・この順で出します）</h4>
        {selection.length ? (
          <ol>
            {selection.map((w, index) => (
              <li key={w.id}>
                <span>{w.title}<small>{w.code}</small></span>
                <span className="bc-action-buttons">
                  <button type="button" className="secondary" aria-label={`${w.title}を上へ`} disabled={index === 0} onClick={() => move(index, -1)}>↑</button>
                  <button type="button" className="secondary" aria-label={`${w.title}を下へ`} disabled={index === selection.length - 1} onClick={() => move(index, 1)}>↓</button>
                  <button type="button" className="secondary" aria-label={`${w.title}を外す`} onClick={() => setSelection((current) => current.filter((x) => x.id !== w.id))}>外す</button>
                </span>
              </li>
            ))}
          </ol>
        ) : <p className="rp-muted">まだありません。照合するか、放送履歴表の「リストに入れる」を押してください。</p>}
        <div className="bw-filters">
          <label>基準日（予定・一部予定の判定と放送アベイルズ状況の計算）<input type="date" value={asOf} onChange={(event) => event.target.value && setAsOf(event.target.value)} /></label>
          {selection.length
            ? <a className="bc-link-button" href={href} download>放送アベイルズリストを Excel で出力（{selection.length}件）</a>
            : <span className="rp-muted">作品を1件以上選ぶと出力できます（0件では出力しません）</span>}
          {selection.length > 0 && <button type="button" className="secondary" onClick={() => setSelection([])}>すべて外す</button>}
        </div>
      </section>
    </details>
  );
}

export default AvailsListPanel;
