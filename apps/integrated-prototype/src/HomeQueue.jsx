// ホーム。選んだ作品の概要と、役割に応じた「次に対応すること」（作業キュー）を1画面で示す。
// 各カードから該当の画面へ1手で移れる。対応待ちが無い項目は小さく畳んで表示する。
import React, {useEffect, useState} from 'react';
import {useShell} from './shell/context.mjs';
import {Notice} from './ui/Notice.jsx';
import './home-queue.css';

const TONE_LABEL = {bad: '要対応', warn: '確認待ち', info: 'お知らせ'};

export function HomeQueue({data}) {
  const shell = useShell();
  const [state, setState] = useState({loading: true});
  const load = () => {
    setState((previous) => ({...previous, loading: true, error: null}));
    shell.request('/work-queue').then((body) => setState({body})).catch((error) => setState({error}));
  };
  useEffect(load, []); // eslint-disable-line react-hooks/exhaustive-deps
  const work = data.works.find((w) => w.id === data.selectedWorkId);
  const items = state.body?.items || [];
  const open = items.filter((item) => item.count > 0);
  const quiet = items.filter((item) => item.count === 0);
  // 行が自分の開き先（page・params。例: 表編集の下書き）を持つときはそれを優先する
  const go = (item, row) => shell.navigate(row?.page || item.page, {...(item.params || {}), ...(row?.params || {})}, {workId: row?.workId});
  return (
    <div className="stack hq">
      <section className="card hq-hero">
        <div>
          <p className="hq-eyebrow">いま選んでいる作品</p>
          <h2>{work?.title || '作品を選んでください'}</h2>
          <p className="hq-sub">{work ? `${work.code}・企画から売上まで同じ作品のデータを見ています` : '上の「対象作品」から選びます'}</p>
        </div>
        <dl className="hq-stats">
          <div><dt>案件</dt><dd>{data.projects.length}</dd></div>
          <div><dt>作品</dt><dd>{data.works.length}</dd></div>
          <div><dt>商品</dt><dd>{data.products.length}</dd></div>
          <div><dt>取引先</dt><dd>{data.partners.length}</dd></div>
        </dl>
      </section>
      <section className="hq-queue" aria-label="次に対応すること">
        <header className="hq-head">
          <h2>次に対応すること{state.body ? `（${state.body.total}件）` : ''}</h2>
          <button type="button" className="text" onClick={load}>再読込</button>
        </header>
        {state.error && <Notice error={state.error} onRetry={load} />}
        {state.loading && !state.body && <p className="rp-muted" aria-busy="true">読み込み中…</p>}
        {state.body && !open.length && <Notice tone="ok" message="対応待ちはありません。" />}
        <div className="hq-cards">
          {open.map((item) => (
            <article key={item.id} className={`card hq-card is-${item.tone}`}>
              <header>
                <span className={`hq-tone is-${item.tone}`}>{TONE_LABEL[item.tone]}</span>
                <h3>{item.title}</h3>
                <strong className="hq-count">{item.count}<small>件</small></strong>
              </header>
              <ul>
                {item.rows.map((row, index) => (
                  <li key={index}><button type="button" className="hq-row" onClick={() => go(item, row)}><span>{row.label}</span><small>{row.detail}</small></button></li>
                ))}
              </ul>
              {item.count > item.rows.length && <p className="rp-muted">ほか{item.count - item.rows.length}件</p>}
              <button type="button" className="secondary" onClick={() => go(item)}>画面を開く</button>
            </article>
          ))}
        </div>
        {quiet.length > 0 && (
          <p className="hq-quiet">対応待ちなし: {quiet.map((item) => item.title).join('・')}</p>
        )}
      </section>
    </div>
  );
}

export default HomeQueue;
