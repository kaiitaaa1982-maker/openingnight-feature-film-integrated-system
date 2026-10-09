// 番販・放送の「放送ウィンドウ提案」タブ。商品ごとに、放送してよい期間と根拠・独占とホールドバックで塞がっている期間・提案する期間・
// 初回／再放送・同時期の他局・直近3局・許諾回数と残り・要確認の理由を出す。行を開くと時間軸。
// 行の「提案する（下書きを作る）」で、局・放送する月（提案する期間の中）・初回／再放送・メモを選んで放送枠の下書きを作る（ProposalDrafts.jsx）。
// 作った下書きは同じタブの「提案から作った下書き」に出し、合意したら放送枠のタブで申請、合意に至らなければ下書きのうちに削除する。
// 条件（基準日・対象・短い区間の目安）は URL（bpasof・bpscope・bpmin）に残す。
import React, {useCallback, useEffect, useMemo, useRef, useState} from 'react';
import {useShell} from '../shell/context.mjs';
import {DataGrid} from '../ui/DataGrid.jsx';
import {Notice} from '../ui/Notice.jsx';
import {PROPOSAL_STATES} from './window-proposal-model.mjs';
import {intervalText, dateSlash, ymText} from './intervals.mjs';
import {todayJst} from '../sales-ops/partner-list-model.mjs';
import {StationTypesPanel} from './BroadcastTerms.jsx';
import {DraftComposer, ProposalDraftsPanel} from './ProposalDrafts.jsx';
import './broadcast-windows.css';

const STATE_TONE = {ok: 'is-ok', full: 'is-warn', blocked: 'is-bad'};
const dayNumber = (iso) => Date.parse(`${iso}T00:00:00Z`) / 86400000;

// 時間軸（基準日〜24か月後）。棒は期間、文字は棒の上に出す（色だけに頼らない）
export function ProposalTimeline({timeline}) {
  const start = dayNumber(timeline.from), end = dayNumber(timeline.to), span = Math.max(1, end - start + 1);
  const pos = (bar) => {
    const a = Math.max(start, bar.from ? dayNumber(bar.from) : start), b = Math.min(end, bar.to ? dayNumber(bar.to) : end);
    return {left: `${((a - start) / span) * 100}%`, width: `${Math.max(0.6, ((b - a + 1) / span) * 100)}%`};
  };
  const years = [];
  for (let y = Number(timeline.from.slice(0, 4)) + 1; y <= Number(timeline.to.slice(0, 4)); y += 1) years.push(y);
  return (
    <figure className="bw-timeline" aria-label={`時間軸 ${dateSlash(timeline.from)}〜${dateSlash(timeline.to)}`}>
      <div className="bw-axis" aria-hidden="true">
        <span style={{left: 0}}>{dateSlash(timeline.from)}</span>
        {years.map((y) => <span key={y} style={{left: `${((dayNumber(`${y}-01-01`) - start) / span) * 100}%`}}>{y}年</span>)}
        <span style={{right: 0}}>{dateSlash(timeline.to)}</span>
      </div>
      {timeline.lanes.map((lane) => (
        <div className="bw-lane" key={lane.key}>
          <span className="bw-lane-label">{lane.label}</span>
          <div className="bw-lane-track">
            {lane.bars.length ? lane.bars.map((bar, index) => (
              <span key={index} className={`bw-bar is-${lane.key}`} style={pos(bar)} title={`${bar.label}：${intervalText(bar)}`}>{bar.label}</span>
            )) : <span className="bw-bar-none">なし</span>}
          </div>
        </div>
      ))}
      <figcaption className="rp-muted">棒の上に指すと期間が出ます。独占とホールドバックの期間は提案から除き、同時期の他局は塞ぎません。</figcaption>
    </figure>
  );
}

// 下書きを作った知らせ（入力のあった行の中に出す）。表の下のほうの行から作っても見えるよう、出したらこの枠へフォーカスを移して画面に入れる
// （入力が閉じると、押したボタンが消えてフォーカスが body へ落ちるため）。上部の固定の帯に隠れないよう scroll-margin-top を付けてある（.bw-created）
export function DraftCreatedNotice({message, onShowDrafts, onAgain}) {
  const ref = useRef(null);
  useEffect(() => {
    ref.current?.focus({preventScroll: true});
    ref.current?.scrollIntoView?.({block: 'nearest'});
  }, [message]);
  return (
    <div className="bw-created" ref={ref} tabIndex={-1} aria-label="下書きを作った知らせ">
      <Notice tone="ok" compact message={message} actions={(
        <>
          <button type="button" className="secondary" onClick={onShowDrafts}>作った下書きを見る</button>
          {onAgain && <button type="button" className="text" onClick={onAgain}>続けて提案する</button>}
        </>
      )} />
    </div>
  );
}

// compose: 提案から下書きを作る入力の状態（{open, created, stations, asOf, minMonths, request, onOpen, onClose, onCreated, onShowDrafts}）。無ければ出さない
export function ProposalDetail({row, compose = null}) {
  const shell = useShell();
  const r = row.result;
  const exclusivityText = (l) => (l.exclusivity === 'exclusive' ? '独占' : l.exclusivity === 'nonexclusive' ? '非独占' : '独占未確認');
  const missingTerms = (l) => l.licensed === null || l.holdbackMonths === null;
  const canPropose = Boolean(compose) && r.state === 'ok' && row.can_edit && !shell.readOnly;
  return (
    <div className="rp-drill bw-detail">
      {canPropose && (compose.created
        ? <DraftCreatedNotice message={compose.created} onShowDrafts={compose.onShowDrafts} onAgain={compose.onOpen} />
        : compose.open
          ? <DraftComposer row={row} asOf={compose.asOf} minMonths={compose.minMonths} stations={compose.stations} request={compose.request} onCreated={compose.onCreated} onClose={compose.onClose} />
          : <p><button type="button" onClick={compose.onOpen}>提案する（下書きを作る）</button></p>)}
      {compose && r.state === 'ok' && !row.can_edit && <p className="rp-muted">提案から放送枠の下書きを作れるのは、案件の編集権限がある人です。</p>}
      <ProposalTimeline timeline={r.timeline} />
      <div className="bw-detail-grid">
        <section><h5>放送してよい期間と根拠</h5><p>{row.allowed_text}</p><ul>{r.basis.map((b) => <li key={b}>{b}</li>)}</ul></section>
        <section><h5>塞がっている期間</h5>{r.blocked.length ? <ul>{r.blocked.map((b, i) => <li key={i}>{intervalText(b)} {b.station}（{b.kind === 'holdback' ? `ホールドバック${b.months}か月` : '独占'}{b.planned ? '・予定' : ''}{b.productScoped ? '・この商品の指定' : ''}）</li>)}</ul> : <p className="rp-muted">なし</p>}</section>
        <section><h5>提案する期間</h5>{r.proposals.length ? <ul>{r.proposals.map((p, i) => <li key={i}>{intervalText(p)}（{p.run}{p.short ? '・短い' : ''}）{p.others.length ? `／同時期の他局: ${p.others.map((o) => o.station).join('・')}` : ''}</li>)}</ul> : <p className="rp-muted">{r.state === 'blocked' ? '提案なし（要確認の理由を見てください）' : '24か月以内に空きはありません'}</p>}</section>
        <section><h5>許諾回数と残り</h5>
          <p className="rp-muted">許諾放送回数・ホールドバックは 営業基幹 › 取引先別リスト › 局のリスト › 明細を開いた「放送の条件」で入れます（版で積みます）。</p>
          {r.licenses.length ? <ul>{r.licenses.map((l) => (
            <li key={l.entryId}>{l.station}（明細 {l.entryId}・{exclusivityText(l)}）: {l.licensed === null ? '許諾回数は未確認' : `${l.licensed}回中${l.used}回・残り${l.remaining}回`}{l.holdbackMonths === null ? '・ホールドバック未確認' : `・ホールドバック${l.holdbackMonths}か月`}
              {missingTerms(l) && l.partnerId && l.listId && !shell.readOnly && (
                <button type="button" className="text" onClick={() => shell.navigate('取引先別リスト', {plpartner: String(l.partnerId), pllist: String(l.listId)})}>取引先別リストで入れる（明細 {l.entryId}）</button>
              )}
            </li>
          ))}</ul> : <p className="rp-muted">放送の契約の明細はありません</p>}</section>
        <section><h5>直近の放送局</h5>{r.recent.length ? <ul>{r.recent.map((x) => <li key={x.key}>{x.historyText}</li>)}</ul> : <p className="rp-muted">放送実績なし</p>}</section>
        {r.reasons.length > 0 && <section><h5>要確認</h5><ul>{r.reasons.map((x) => <li key={x}>{x}</li>)}</ul></section>}
      </div>
    </div>
  );
}

// onChanged: 下書きを作った・削除した後に、番販・放送の画面全体（放送枠のタブの行と件数・承認待ちの件数）を読み直す
export function WindowProposals({request, workId, work, readOnly, onOpenSlot, onChanged}) {
  const shell = useShell();
  const asOf = shell.getParam('bpasof', null) || todayJst();
  const scope = shell.getParam('bpscope', null) || 'work';
  const minMonths = shell.getParam('bpmin', null) || '3';
  const setParam = (key, value, fallback) => shell.setParam(key, value === fallback ? null : value, {replace: true});
  const [state, setState] = useState({loading: true});
  const [drafts, setDrafts] = useState({});
  const [composeKey, setComposeKey] = useState(null);
  const [createdFor, setCreatedFor] = useState(null); // {key, message}: 下書きを作った行と知らせ（その行の中に出す）
  const [expand, setExpand] = useState(null);
  const [notice, setNotice] = useState(null);
  const draftsRef = useRef(null);
  const query = useMemo(() => {
    const p = new URLSearchParams({asOf, minMonths});
    if (scope === 'work' && workId) p.set('workId', String(workId));
    return p.toString();
  }, [asOf, minMonths, scope, workId]);
  const draftQuery = scope === 'work' && workId ? `?workId=${workId}` : '';
  const load = useCallback(async () => {
    setState((s) => ({...s, loading: true}));
    try { setState({body: await request(`/broadcast/window-proposals?${query}`)}); } catch (error) { setState({error}); }
  }, [request, query]);
  const loadDrafts = useCallback(async () => {
    try { setDrafts({body: await request(`/broadcast/window-proposals/drafts${draftQuery}`)}); } catch (error) { setDrafts({error}); }
  }, [request, draftQuery]);
  useEffect(() => { load(); }, [load]);
  useEffect(() => { loadDrafts(); }, [loadDrafts]);
  // 提案の表・下書きの一覧に加えて、番販・放送の画面全体も読み直す（放送枠のタブへ移ったときに、作った下書き・削除した下書きが今の状態で出るように）
  const reloadAll = useCallback(async () => { await Promise.all([load(), loadDrafts(), onChanged?.()]); }, [load, loadDrafts, onChanged]);
  // 行の「提案する（下書きを作る）」: その行を開き、入力を出す
  const openCompose = useCallback((key) => { setCreatedFor(null); setComposeKey(key); setExpand({key, nonce: Date.now()}); }, []);
  const created = useCallback(async (result) => {
    setComposeKey(null);
    const message = `${result.row.work_title}（${result.row.product_sku || '作品全体'}）の提案から、${result.station.name}へ放送枠の下書きを${result.count}件作りました（${result.months.map(ymText).join('・')}）。合意したら下の「提案から作った下書き」の「放送枠を開く」から申請してください`;
    setNotice({tone: 'ok', message});
    setCreatedFor({key: result.row.key, message});
    await reloadAll();
  }, [reloadAll]);
  const showDrafts = useCallback(() => draftsRef.current?.scrollIntoView?.({block: 'start'}), []);
  const openSlot = useCallback((row) => onOpenSlot?.(row.work_id, row.broadcast_month, row.slot_id), [onOpenSlot]);
  const columns = useMemo(() => [
    {key: 'product', label: '商品（品番）', type: 'text', sticky: true, value: (row) => `${row.product_sku || '—'} ${row.product_name}`,
      render: (row) => <span className="bc-work"><span>{row.product_name}</span><small>{row.product_sku || '放送用の商品なし'}｜{row.work_code}</small></span>},
    {key: 'work_title', label: '作品', type: 'text'},
    {key: 'state', label: '判定', type: 'text', value: (row) => PROPOSAL_STATES[row.state], render: (row) => <span className={`bc-flag ${STATE_TONE[row.state]}`}>{PROPOSAL_STATES[row.state]}</span>},
    {key: 'allowed_text', label: '放送してよい期間', type: 'text', wrap: true},
    {key: 'blocked_text', label: '独占・ホールドバックで塞がっている期間', type: 'text', wrap: true},
    {key: 'proposal_text', label: '提案する期間', type: 'text', wrap: true},
    {key: 'run_text', label: '初回／再放送', type: 'text'},
    {key: 'others_text', label: '同時期の他局', type: 'text', wrap: true},
    {key: 'recent_text', label: '直近の放送局（3局まで）', type: 'text', wrap: true},
    {key: 'license_text', label: '許諾回数と残り', type: 'text', wrap: true},
    {key: 'reasons_text', label: '要確認の理由', type: 'text', wrap: true},
    {key: 'actions', label: '操作', type: 'text', export: false, value: () => null, render: (row) => (row.state === 'ok' && row.can_edit && !readOnly
      ? <button type="button" className="secondary" onClick={() => openCompose(row.key)}>提案する（下書きを作る）</button>
      : <span className="bc-muted">{row.state !== 'ok' ? '提案できる期間なし' : '閲覧のみ'}</span>)},
  ], [readOnly, openCompose]);
  const body = state.body;
  const compose = (row) => ({open: composeKey === row.key, created: createdFor?.key === row.key ? createdFor.message : null, stations: drafts.body?.stations || [], asOf: body?.asOf || asOf, minMonths, request,
    onOpen: () => { setCreatedFor(null); setComposeKey(row.key); }, onClose: () => setComposeKey(null), onCreated: created, onShowDrafts: showDrafts});
  return (
    <div className="bw-stack">
      <section className="card rp-report" aria-label="放送ウィンドウ提案">
        <header className="rp-head">
          <div>
            <h3>商品別の放送ウィンドウ提案{scope === 'work' && work ? `（${work.title}）` : '（閲覧できる全作品）'}</h3>
            <p className="rp-muted">権利範囲（放送）・放送の解禁・商品別の販売ウィンドウ（無ければ作品共通の販売条件）の重なりから、独占の契約とホールドバックの期間を除いた期間を提案します（基準日から24か月）。
              行を押すと時間軸が開きます。「提案する（下書きを作る）」で、局と提案する期間の中の月を選んで放送枠の下書きを作れます（表を見ただけでは何も登録しません）。</p>
          </div>
          <div className="bc-action-buttons">
            <a className="bc-link-button" href={`/api/broadcast/window-proposals/export.xlsx?${query}`} download>Excelで出力</a>
            <button type="button" className="secondary" onClick={load}>再読込</button>
          </div>
        </header>
        <div className="bw-filters" role="search" aria-label="放送ウィンドウ提案の条件">
          <label>基準日<input type="date" value={asOf} onChange={(event) => event.target.value && setParam('bpasof', event.target.value, todayJst())} /></label>
          <label>対象<select value={scope} onChange={(event) => setParam('bpscope', event.target.value, 'work')}><option value="work">選んでいる作品の商品</option><option value="all">閲覧できる全作品</option></select></label>
          <label>短い区間の目安<select value={minMonths} onChange={(event) => setParam('bpmin', event.target.value, '3')}>{[1, 2, 3, 6, 12].map((n) => <option key={n} value={String(n)}>{n}か月未満</option>)}</select></label>
        </div>
        {state.error && <Notice error={state.error} onRetry={load} />}
        {notice && <Notice tone={notice.tone} message={notice.message} error={notice.error} onDismiss={() => setNotice(null)} />}
        {body && <p className="rp-muted" role="status">{body.counts.rows}行（{PROPOSAL_STATES.ok} {body.counts.ok}・{PROPOSAL_STATES.full} {body.counts.full}・{PROPOSAL_STATES.blocked} {body.counts.blocked}）・基準日 {dateSlash(body.asOf)}</p>}
        {body && (
          <DataGrid columns={columns} rows={body.rows} rowKey="key" persistKey="broadcast-proposals" ariaLabel="放送ウィンドウ提案の一覧" showTotals={false}
            emptyText="対象の作品がありません" initialSort={{key: 'product', dir: 'asc'}} expandRequest={expand}
            exportSpec={{name: '放送ウィンドウ提案', title: '商品別の放送ウィンドウ提案'}}
            renderDetail={(row) => <ProposalDetail row={row} compose={compose(row)} />} />
        )}
      </section>
      <div className="bw-scroll-target" id="bw-proposal-drafts" ref={draftsRef}>
        <ProposalDraftsPanel drafts={drafts.body} error={drafts.error} onReload={reloadAll} request={request} readOnly={readOnly} onOpenSlot={openSlot}
          title={`提案から作った下書き${scope === 'work' && work ? `（${work.title}）` : '（閲覧できる全作品）'}`} />
      </div>
      <StationTypesPanel request={request} readOnly={readOnly} />
    </div>
  );
}

export default WindowProposals;
