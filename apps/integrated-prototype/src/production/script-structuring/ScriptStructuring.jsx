import React, {useEffect, useMemo, useRef, useState} from 'react';
import workerUrl from 'pdfjs-dist/legacy/build/pdf.worker.min.mjs?url';
import {
  DAY_NIGHT_LABELS, FIELD_LABELS, STATUS_LABELS, approvalState, appliedRules, cardPage, editCard, extractedScene,
  hasProvenance, markCounts, markKind, markState, pageBoxes, pageSummary, setChecked,
} from './script-structuring-model.mjs';
import './script-structuring.css';

// 台本の構造化画面（FR-PROD-STRUCT-001・010）。左に保存した原本の頁と柱の枠、右に読み取ったシーンを並べ、
// 補った値・読めない値だけを人が確かめてから承認する。原本の頁は pdf.js（互換版。古いブラウザでも動く legacy の版）で描く。
// 枠は読み取りが返した割合（頁の幅・高さに対する 0〜1）を CSS の変数で置き、拡大縮小しても原本と重なるようにする。

const BASE = import.meta.env?.BASE_URL || '/';
let pdfjsPromise = null;
function loadPdfjs() {
  pdfjsPromise ||= import('pdfjs-dist/legacy/build/pdf.mjs').then((pdfjs) => {
    pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;
    return pdfjs;
  }).catch((error) => {
    // 失敗した読み込みを持ち続けず、次に開くときに読み直す
    pdfjsPromise = null;
    throw error;
  });
  return pdfjsPromise;
}
const bytesOf = (base64) => Uint8Array.from(atob(base64), (ch) => ch.charCodeAt(0));
const isPdf = (original) => /pdf/i.test(original?.mediaType || '') || /\.pdf$/i.test(original?.fileName || '');
const STATE_LABELS = {checked: '確かめた', edited: '直した'};
const TONE_LABELS = {open: '要確認あり', done: '確かめ済み', read: 'そのまま読めた'};
// 登録済み（読むだけ）の台本では、確かめていない印を「確かめずに登録」と出す（読むだけでは確かめられないので、要確認とは言わない）
const READONLY_TONE_LABELS = {...TONE_LABELS, open: '確かめずに登録'};
const BOX_WORDS = {open: ' 要確認', done: ' 確認済', read: ''};

function useWidth(node) {
  const [width, setWidth] = useState(0);
  useEffect(() => {
    if (!node) return undefined;
    const measure = () => setWidth(node.clientWidth);
    measure();
    if (typeof ResizeObserver !== 'function') return undefined;
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, [node]);
  return width;
}

function PdfCanvas({doc, page, width, label, onRendered}) {
  const canvasRef = useRef(null);
  useEffect(() => {
    if (!doc || !width) return undefined;
    let cancelled = false;
    let task = null;
    (async () => {
      const pdfPage = await doc.getPage(page);
      if (cancelled) return;
      const base = pdfPage.getViewport({scale: 1});
      const ratio = typeof window !== 'undefined' && window.devicePixelRatio ? window.devicePixelRatio : 1;
      const viewport = pdfPage.getViewport({scale: (width / base.width) * ratio});
      const canvas = canvasRef.current;
      canvas.width = viewport.width;
      canvas.height = viewport.height;
      canvas.style.aspectRatio = `${base.width} / ${base.height}`;
      task = pdfPage.render({canvas, canvasContext: canvas.getContext('2d'), viewport});
      await task.promise;
      if (!cancelled) onRendered?.(page);
    })().catch((error) => {
      if (!cancelled && error?.name !== 'RenderingCancelledException') onRendered?.(page, error);
    });
    return () => {
      cancelled = true;
      task?.cancel?.();
    };
  }, [doc, page, width]);
  return <canvas ref={canvasRef} className="ss-canvas" role="img" aria-label={label} />;
}

// 頁の一覧の小さな絵。見えてから描く（何百頁でも一度に描かない）
function Thumb({doc, page, current, open, onSelect}) {
  const ref = useRef(null);
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    const node = ref.current;
    if (!node || visible) return undefined;
    if (typeof IntersectionObserver !== 'function') {
      setVisible(true);
      return undefined;
    }
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) setVisible(true);
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, [visible]);
  return (
    <li ref={ref}>
      <button type="button" className={`ss-thumb${current ? ' is-current' : ''}`} aria-current={current ? 'page' : undefined} aria-label={`${page}頁${open ? `（要確認 ${open}件）` : ''}`} onClick={() => onSelect(page)}>
        {visible && doc ? <PdfCanvas doc={doc} page={page} width={72} label={`${page}頁の縮小`} /> : <span className="ss-thumb-blank" />}
        <span className="ss-thumb-no">{page}</span>
        {open > 0 && <span className="ss-thumb-mark">要確認 {open}</span>}
      </button>
    </li>
  );
}

function OriginalPane({artifactId, extraction, cards, selected, page, setPage, onSelect, request}) {
  const [original, setOriginal] = useState(null);
  const [doc, setDoc] = useState(null);
  const [state, setState] = useState({kind: 'loading'});
  const [attempt, setAttempt] = useState(0);
  const [renderError, setRenderError] = useState(null);
  const [pageNode, setPageNode] = useState(null);
  const width = useWidth(pageNode);
  useEffect(() => {
    let cancelled = false;
    let task = null;
    setDoc(null);
    setOriginal(null);
    setRenderError(null);
    setState({kind: 'loading'});
    request(`/workflow/scripts/${artifactId}/original`).then(async (x) => {
      if (cancelled) return;
      setOriginal(x);
      if (!isPdf(x)) {
        setState({kind: 'text'});
        return;
      }
      const pdfjs = await loadPdfjs();
      // 原本は利用者が上げたファイルなので、描くのに要る機能だけを使う。WebAssembly の復号は使わない（CSP に 'wasm-unsafe-eval' を足さない）。
      // JPEG 2000・JBIG2 の画像は、WebAssembly を使わない JavaScript の復号（pdfjs/wasm/ の *_nowasm_fallback.js）で描く。
      // 文字の対応表・書体・復号は同じオリジンから読む。画像は1枚2,500万画素まで（大きすぎる画像でタブを固めない）
      task = pdfjs.getDocument({data: bytesOf(x.base64), cMapUrl: `${BASE}pdfjs/cmaps/`, cMapPacked: true, standardFontDataUrl: `${BASE}pdfjs/standard_fonts/`, wasmUrl: `${BASE}pdfjs/wasm/`, useWasm: false, enableXfa: false, maxImageSize: 25000000});
      const loaded = await task.promise;
      if (cancelled) {
        loaded.destroy();
        return;
      }
      setDoc(loaded);
      setState({kind: 'ready', pages: loaded.numPages});
    }).catch((error) => {
      if (!cancelled) setState({kind: 'error', message: error?.message || '原本を開けませんでした'});
    });
    return () => {
      cancelled = true;
      task?.destroy?.();
    };
  }, [artifactId, attempt]);
  const pages = state.kind === 'ready' ? state.pages : 0;
  // 読み取りの頁が原本の頁数を超えていても（原本と読み取りの食い違い）、原本にある頁だけを描く
  const current = pages ? Math.min(Math.max(1, page), pages) : page;
  useEffect(() => {
    if (pages && current !== page) setPage(current);
  }, [pages, current, page]);
  const boxes = useMemo(() => pageBoxes(cards, extraction, current), [cards, extraction, current]);
  const summary = useMemo(() => pageSummary(cards, extraction, pages), [cards, extraction, pages]);
  const onPage = summary[current - 1];
  const onRendered = (rendered, error) => setRenderError(error ? {page: rendered, message: error.message || '理由が分かりません'} : null);
  return (
    <section className="ss-original" aria-label="台本の原本">
      <header className="ss-pane-head">
        <h4>原本</h4>
        <span className="ss-file">{original?.fileName || ''}</span>
        <span className="ss-keep">原本は保存したまま（書き換えない）</span>
      </header>
      {state.kind === 'loading' && <p className="ss-empty">原本を読み込んでいます…</p>}
      {state.kind === 'error' && (
        <p className="ss-empty ss-error" role="alert">
          原本を表示できません: {state.message}
          <button type="button" className="text" onClick={() => setAttempt((n) => n + 1)}>もう一度読み込む</button>
        </p>
      )}
      {state.kind === 'text' && <pre className="ss-text">{extraction?.text || ''}</pre>}
      {state.kind === 'ready' && (
        <>
          <div className="ss-page-nav">
            <button type="button" className="text" disabled={current <= 1} onClick={() => setPage(current - 1)}>前の頁</button>
            <span>{current} / {pages}頁{onPage ? `・シーン ${onPage.scenes}件` : ''}</span>
            <button type="button" className="text" disabled={current >= pages} onClick={() => setPage(current + 1)}>次の頁</button>
          </div>
          {renderError?.page === current && <p className="ss-empty ss-error" role="alert">原本の{current}頁を描けませんでした: {renderError.message}</p>}
          <div className="ss-page" ref={setPageNode}>
            <PdfCanvas doc={doc} page={current} width={width} label={`原本の${current}頁`} onRendered={onRendered} />
            {boxes.map((b) => (
              <button
                type="button"
                key={b.cardIndex}
                className={`ss-box ss-box-${b.tone}${selected === b.cardIndex ? ' is-selected' : ''}`}
                style={{'--l': b.box.left, '--t': b.box.top, '--w': b.box.width, '--h': b.box.height}}
                aria-label={`S#${b.sceneNo || '番号なし'}の柱（${TONE_LABELS[b.tone]}）`}
                onClick={() => onSelect(b.cardIndex)}
              >
                <span className="ss-box-label">S#{b.sceneNo || '?'}{BOX_WORDS[b.tone]}</span>
              </button>
            ))}
          </div>
          <ol className="ss-thumbs" aria-label="頁の一覧">
            {summary.map((p) => <Thumb key={p.page} doc={doc} page={p.page} current={p.page === current} open={p.open} onSelect={setPage} />)}
          </ol>
        </>
      )}
    </section>
  );
}

// 項目の印。読めた値は短く（理由は title）、補った値・読めない値は理由を下の行に出す
function Mark({card, field, extraction}) {
  const extracted = extractedScene(card, extraction);
  const info = extracted?.fields?.[field];
  if (!info) return null;
  const state = markState(card, field, extraction);
  const label = state === 'none' ? STATUS_LABELS.read : state === 'open' ? STATUS_LABELS[info.status] || '要確認' : STATE_LABELS[state];
  const tone = state === 'open' ? markKind(info.status) : state === 'none' ? 'read' : 'done';
  return (
    <span className={`ss-mark ss-mark-${tone}`} title={info.reason || undefined}>
      <span className="ss-dot" aria-hidden="true" />
      <span className="ss-mark-label">{label}</span>
    </span>
  );
}

// 出演者はセリフの話者から読むので、ト書きにだけ出る人物は入らない。印が無くても読み方を見せ、足りない人を足してもらう
const ALWAYS_REASON = new Set(['cast']);

function Reason({card, field, extraction}) {
  const info = extractedScene(card, extraction)?.fields?.[field];
  const state = markState(card, field, extraction);
  if (!info?.reason || (state === 'none' && !ALWAYS_REASON.has(field))) return null;
  return <span className={`ss-reason${state === 'open' ? '' : ' is-done'}`}>{state === 'none' ? '読み方' : '理由'}: {info.reason}</span>;
}

function CheckBox({card, field, extraction, readOnly, onChange}) {
  const state = markState(card, field, extraction);
  if (state === 'none' || state === 'edited') return null;
  return (
    <label className="ss-check">
      <input type="checkbox" disabled={readOnly} checked={state === 'checked'} onChange={(e) => onChange(setChecked(card, field, e.target.checked))} aria-label={`S#${card.sceneNo}の${FIELD_LABELS[field]}を確かめた`} />
      確かめた
    </label>
  );
}

function SceneCard({card, index, extraction, selected, readOnly, onSelect, onChange, onRemove, cardRef}) {
  const toneLabels = readOnly ? READONLY_TONE_LABELS : TONE_LABELS;
  const edit = (key, value) => onChange(editCard(card, key, value));
  const page = cardPage(card, extraction);
  const states = ['sceneNo', 'location', 'dayNight', 'cast', 'pageEighths'].map((key) => markState(card, key, extraction));
  const tone = states.includes('open') ? 'open' : states.some((s) => s !== 'none') ? 'done' : 'read';
  const row = (key, control) => (
    <div className="ss-field" key={key}>
      <span className="ss-field-name">{FIELD_LABELS[key]}</span>
      <span className="ss-field-value">{control}</span>
      <Mark card={card} field={key} extraction={extraction} />
      <CheckBox card={card} field={key} extraction={extraction} readOnly={readOnly} onChange={onChange} />
      <Reason card={card} field={key} extraction={extraction} />
    </div>
  );
  return (
    <article ref={cardRef} className={`ss-card ss-card-${tone}${selected ? ' is-selected' : ''}`} aria-label={`S#${card.sceneNo || '番号なし'}`} onFocusCapture={() => onSelect(index)} onClick={() => onSelect(index)}>
      <header className="ss-card-head">
        <span className="ss-scene-no">S#{card.sceneNo || '番号なし'}</span>
        <span className="ss-card-title">{card.location || '場所 未入力'}</span>
        <span className={`ss-chip ss-chip-${tone}`}>{toneLabels[tone]}</span>
        <span className="ss-card-page">{page ? `原本 ${page}頁` : '原本の位置なし'}</span>
      </header>
      <div className="ss-fields">
        {row('sceneNo', <input aria-label={`シーン${index + 1}番号`} value={card.sceneNo || ''} disabled={readOnly} onChange={(e) => edit('sceneNo', e.target.value)} />)}
        {row('location', <input aria-label={`シーン${index + 1}場所`} value={card.location || ''} disabled={readOnly} onChange={(e) => edit('location', e.target.value)} />)}
        {row('dayNight', (
          <select aria-label={`シーン${index + 1}昼夜`} value={card.dayNight || ''} disabled={readOnly} onChange={(e) => edit('dayNight', e.target.value || null)}>
            <option value="">未確認</option>
            {Object.entries(DAY_NIGHT_LABELS).map(([code, label]) => <option key={code} value={code}>{label}</option>)}
          </select>
        ))}
        {row('cast', <input aria-label={`シーン${index + 1}出演者`} value={(card.cast || []).join(',')} disabled={readOnly} onChange={(e) => edit('cast', e.target.value.split(',').map((v) => v.trim()).filter(Boolean))} />)}
        {row('pageEighths', <input aria-label={`シーン${index + 1}頁`} type="number" min="1" value={card.pageEighths ?? ''} disabled={readOnly} onChange={(e) => edit('pageEighths', e.target.value)} />)}
        <div className="ss-field">
          <span className="ss-field-name">予定分</span>
          <span className="ss-field-value"><input aria-label={`シーン${index + 1}予定分`} type="number" min="1" value={card.estimatedMinutes ?? ''} disabled={readOnly} onChange={(e) => onChange({...card, estimatedMinutes: e.target.value})} /></span>
        </div>
        <div className="ss-field ss-field-wide">
          <span className="ss-field-name">概要</span>
          <span className="ss-field-value"><input aria-label={`シーン${index + 1}概要`} value={card.synopsis || ''} disabled={readOnly} onChange={(e) => onChange({...card, synopsis: e.target.value})} /></span>
        </div>
      </div>
      {card.reviewNotes?.length > 0 && <ul className="ss-notes">{card.reviewNotes.map((note) => <li key={note}>{note}</li>)}</ul>}
      {!readOnly && <button type="button" className="text ss-remove" onClick={(e) => { e.stopPropagation(); onRemove(index); }}>このシーンを外す</button>}
    </article>
  );
}

export function ScriptStructuring({artifactId, extraction, cards, onChange, onApprove, onReset, onAdd, readOnly, busy, request, savedVersion}) {
  const [selected, setSelected] = useState(null);
  const [page, setPage] = useState(1);
  const cardRefs = useRef([]);
  const counts = useMemo(() => markCounts(cards, extraction), [cards, extraction]);
  const approval = useMemo(() => approvalState(cards, extraction), [cards, extraction]);
  const rules = appliedRules(extraction);
  // 出どころの無い前の読み取り（シーンはあるが項目ごとの状態が無い）。シーンを読めなかった読み取りは前の読み取りと言わない
  const legacy = (extraction?.scenes || []).length > 0 && !hasProvenance(extraction);
  useEffect(() => {
    setSelected(null);
    setPage(1);
  }, [artifactId]);
  function select(index, {scroll = false} = {}) {
    setSelected(index);
    const target = cardPage(cards[index], extraction);
    if (target) setPage(target);
    if (scroll) cardRefs.current[index]?.scrollIntoView?.({block: 'nearest', behavior: 'smooth'});
  }
  function jumpToNextMark() {
    const next = approval.open[0];
    if (next) select(next.cardIndex, {scroll: true});
  }
  return (
    <div className="ss-root">
      <div className="ss-summary" role="status">
        <span>シーン <strong>{cards.length}</strong>件</span>
        {readOnly
          ? <span className="ss-summary-detail">登録済みの版{savedVersion ? `（第${savedVersion}版）` : ''}を読むだけで開いています。読み取りが付けた印: 補った {counts.inferred}・読めない {counts.missing}（確かめずに登録 {counts.open}）</span>
          : <>
            <span className={`ss-summary-open${approval.open.length ? '' : ' is-clear'}`}>要確認 <strong>{approval.open.length}</strong>件</span>
            <span className="ss-summary-detail">読み取りが付けた印: 補った {counts.inferred}・読めない {counts.missing}（確かめ済み・直した {counts.resolved}）</span>
            {approval.open.length > 0 && <button type="button" className="text" onClick={jumpToNextMark}>次の要確認へ</button>}
          </>}
      </div>
      {legacy && <p className="ss-legacy">この原本は前の読み取りで読んだため、柱の枠と値ごとの出どころがありません。値は原本と見比べて確かめてください。</p>}
      <div className="ss-split">
        <OriginalPane artifactId={artifactId} extraction={extraction} cards={cards} selected={selected} page={page} setPage={setPage} onSelect={(i) => select(i, {scroll: true})} request={request} />
        <section className="ss-scenes" aria-label="読み取ったシーン">
          <header className="ss-pane-head">
            <h4>読み取ったシーン</h4>
            <span className="ss-legend">
              <span className="ss-mark ss-mark-read"><span className="ss-dot" aria-hidden="true" />読めた</span>
              <span className="ss-mark ss-mark-inferred"><span className="ss-dot" aria-hidden="true" />補った・要確認</span>
              <span className="ss-mark ss-mark-missing"><span className="ss-dot" aria-hidden="true" />読めない・要入力</span>
            </span>
          </header>
          {cards.length === 0 && <p className="ss-empty">シーンを読み取れていません。「シーンを足す」で入力してください。</p>}
          <div className="ss-card-list">
            {cards.map((card, index) => (
              <SceneCard
                key={index}
                card={card}
                index={index}
                extraction={extraction}
                selected={selected === index}
                readOnly={readOnly}
                cardRef={(node) => { cardRefs.current[index] = node; }}
                onSelect={(i) => select(i)}
                onChange={(next) => onChange(cards.map((c, n) => (n === index ? next : c)))}
                onRemove={(i) => onChange(cards.filter((_, n) => n !== i))}
              />
            ))}
          </div>
          {rules.length > 0 && (
            <details className="ss-rules" open>
              <summary>変換の決まり（この読み取りで当てたもの）</summary>
              <ul>{rules.map((rule) => <li key={rule.id || rule.label}><span>{rule.label}</span><span className="ss-rule-count">{rule.count}件</span></li>)}</ul>
            </details>
          )}
        </section>
      </div>
      {!readOnly && (
        <div className="ss-actions">
          <button type="button" className="text" onClick={onReset}>読み取り結果に戻す</button>
          <button type="button" className="text" onClick={onAdd}>シーンを足す</button>
          <span className="ss-actions-note">
            {approval.canApprove ? '承認すると、確認済みの版として保存し、香盤の日程づくりへ進みます。' : approval.open.length ? `要確認があと${approval.open.length}件あります。確かめるか直すと承認できます。` : 'シーンを1件以上入れてください。'}
            {savedVersion ? `（第${savedVersion}版を保存済み）` : ''}
          </span>
          <button type="button" disabled={!approval.canApprove || busy} aria-busy={busy ? 'true' : undefined} onClick={onApprove}>承認して香盤へ進む</button>
        </div>
      )}
    </div>
  );
}
