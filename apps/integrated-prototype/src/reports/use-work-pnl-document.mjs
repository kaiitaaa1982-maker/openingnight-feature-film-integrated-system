// 作品別収支の画面（WorkPnlReport.jsx）の読み込みの状態。条件（query）が変わるたびに /reports/work-pnl を読み、
// 表示中の文書データと、data-ready に付ける hash（work-pnl-model.mjs の workPnlReadyHash）を返す。
// 条件を変えて読み直すあいだは前の文書を出したまま hash を null にし、誤り・応答の誤り（ok:false）では文書を外す。
import {useCallback, useEffect, useState} from 'react';
import {workPnlReadyHash} from './work-pnl-model.mjs';

export function useWorkPnlDocument({request, query, valid = true}) {
  const [state, setState] = useState({});
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    if (!query || !valid) { setState({}); return undefined; }
    let live = true;
    setState((previous) => ({...previous, loading: true, error: null, failure: null}));
    request(`/reports/work-pnl?${query}`)
      .then((body) => { if (live) setState(body?.ok === false ? {failure: body.error || '集計できませんでした'} : {body, query}); })
      .catch((error) => { if (live) setState({error}); });
    return () => { live = false; };
  }, [query, valid, request, reloadKey]);

  const reload = useCallback(() => setReloadKey((n) => n + 1), []);
  return {state, doc: state.body?.document || null, hash: workPnlReadyHash(state, query), reload};
}
