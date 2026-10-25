// 1通の見本（U5）。判定の1行、重要な数字、例外だけ、閉じた全行。
// 履歴・落とす・取消・抜き取りは架空の行の画面の中だけ。登録と取消の書き込みは呼ばない。
// 印は台本の構造化（script-structuring）の3段階。読めない・要入力とは書かない（この画面では値を入れさせない）。
// UI指針: ../../../../../docs/design/ui-guidelines.md
import React, {useRef, useState} from 'react';
import {STATUS_LABELS} from '../../production/script-structuring/script-structuring-model.mjs';
import {int} from '../../ui/format.mjs';
import {linkedCsv, linkedFileName, linkedXlsx} from './folders-preview-export.mjs';
import {
  canCommitVoid, exportState, judgmentText, linkedTotals, registerState, samplingLabel, voidBlock,
} from './folders-preview-model.mjs';
import '../../production/script-structuring/script-structuring.css';
import './folders.css';

const MARK_LABEL = Object.freeze({
  read: STATUS_LABELS.read,
  inferred: STATUS_LABELS.inferred,
  missing: '読めない',
});

function amount(row, value) {
  if (value == null) return '未';
  return row.unit === 'yen' ? `${int(value)}円` : int(value);
}

function MarkBadge({status}) {
  const tone = status === 'missing' ? 'missing' : status === 'read' ? 'read' : 'inferred';
  return (
    <span className={`ss-mark ss-mark-${tone}`}>
      <span className="ss-dot" aria-hidden="true" />
      <span className="ss-mark-label">{MARK_LABEL[status] || MARK_LABEL.inferred}</span>
    </span>
  );
}

function SpotList({items}) {
  const [selected, setSelected] = useState(items[0]?.id || null);
  const leftRef = useRef({});
  const rightRef = useRef({});
  if (items.length === 0) return <p data-exceptions="0">なし</p>;
  function choose(id, side) {
    setSelected(id);
    const node = (side === 'left' ? rightRef : leftRef).current[id];
    node?.scrollIntoView?.({block: 'nearest'});
    node?.focus?.();
  }
  return (
    <div className="folders-split">
      <div className="folders-pane" aria-label="原本">
        {items.map((item) => (
          <button
            key={`L-${item.id}`}
            type="button"
            ref={(node) => { leftRef.current[item.id] = node; }}
            className="folders-spot"
            data-exception={item.id}
            data-side="left"
            data-selected={selected === item.id ? 'true' : 'false'}
            aria-pressed={selected === item.id}
            onClick={() => choose(item.id, 'left')}
          >
            <span className="folders-line">{item.line}</span>
            <span>{item.left.filter(Boolean).join(' ')}</span>
            {item.status !== 'read' && <MarkBadge status={item.status} />}
          </button>
        ))}
      </div>
      <div className="folders-pane" aria-label="値">
        {items.map((item) => (
          <button
            key={`R-${item.id}`}
            type="button"
            ref={(node) => { rightRef.current[item.id] = node; }}
            className="folders-spot"
            data-exception={item.id}
            data-side="right"
            data-selected={selected === item.id ? 'true' : 'false'}
            aria-pressed={selected === item.id}
            title={item.title || undefined}
            onClick={() => choose(item.id, 'right')}
          >
            {item.label && <span className="folders-tag">{item.label}</span>}
            <MarkBadge status={item.status} />
            {item.fields.map((field) => <span key={field.name}>{field.name} {field.value}</span>)}
          </button>
        ))}
      </div>
    </div>
  );
}

function stamp(date) {
  const pad = (value) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function saveFile(name, body, type) {
  const blob = new Blob([body], {type});
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = name;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

function Actions({review, onEvent}) {
  const state = registerState(review);
  const block = voidBlock(review);
  const [done, setDone] = useState(false);
  const [note, setNote] = useState('');
  const [voidStep, setVoidStep] = useState(0);
  const [reason, setReason] = useState('');
  const [fix, setFix] = useState('');
  const [voided, setVoided] = useState(false);
  const enabled = state.enabled && !done && !voided;
  const label = done || voided ? '登録済み' : state.label;
  const hidden = !enabled && state.reason && state.reason !== label ? state.reason : '';
  const ready = canCommitVoid({reason, fix});
  return (
    <div data-section="actions">
      {note && <p className="folders-note" role="status" data-preview-action="true">{note}</p>}
      {voided && <p className="folders-note" data-voided="true">消</p>}
      {block && (
        <p className="folders-note folders-void-block" data-void="billed">
          <span>{block.lead}</span>
          <span>{block.rest}</span>
        </p>
      )}
      <div className="folders-actions">
        <button
          type="button"
          disabled={!enabled}
          data-register={enabled ? 'on' : 'off'}
          onClick={() => {
            setDone(true);
            setNote('登録済み');
            onEvent?.({label: '登録', at: stamp(new Date()), who: '管理者', result: '人'});
          }}
        >
          {label}
          {hidden ? <span className="folders-visually-hidden">{hidden}</span> : null}
        </button>
        <button type="button" className="secondary" data-action="recheck" onClick={() => setNote('見本')}>再検査</button>
        {review.kind === 'shape' && <button type="button" className="secondary" data-action="wizard" onClick={() => setNote('手順2')}>手順2</button>}
        <button
          type="button"
          className="secondary"
          data-action="void"
          disabled={Boolean(block) || !review.voidable || voided}
          title={block ? block.lead : (review.voidable ? '取り違え' : '登録前')}
          onClick={() => setVoidStep(1)}
        >取り消す</button>
      </div>
      {voidStep === 1 && !voided && (
        <div className="folders-void" data-void-step="1">
          <p>取り違え</p>
          <div className="folders-actions">
            <button type="button" className="secondary" data-void="back" onClick={() => setVoidStep(0)}>戻る</button>
            <button type="button" data-void="next" onClick={() => setVoidStep(2)}>進む</button>
          </div>
        </div>
      )}
      {voidStep === 2 && !voided && (
        <form
          className="folders-void"
          data-void-step="2"
          onSubmit={(event) => {
            event.preventDefault();
            if (!ready) return;
            setVoided(true);
            setVoidStep(0);
            setNote('消');
            onEvent?.({
              label: '取消',
              at: stamp(new Date()),
              who: '管理者',
              result: fix === 'type' ? '型の誤り' : '原本の誤り',
              note: reason.trim(),
            });
          }}
        >
          <label>理由<input aria-label="理由" value={reason} onChange={(event) => setReason(event.target.value)} /></label>
          <fieldset>
            <legend>直し</legend>
            <label><input type="radio" name="folders-fix" checked={fix === 'type'} onChange={() => setFix('type')} />型の誤り</label>
            <label><input type="radio" name="folders-fix" checked={fix === 'source'} onChange={() => setFix('source')} />原本の誤り</label>
          </fieldset>
          <button type="submit" disabled={!ready} data-void="commit">取り消す</button>
        </form>
      )}
    </div>
  );
}

function ExportPanel({review, finance, registered}) {
  const gate = exportState(review, {finance, registered});
  const totals = linkedTotals(review);
  const [saved, setSaved] = useState('');
  function save(ext) {
    if (!gate.enabled) return;
    const name = linkedFileName(review.fileName, ext);
    const body = ext === 'xlsx'
      ? linkedXlsx(review.linkedHeaders, review.linkedRows)
      : linkedCsv(review.linkedHeaders, review.linkedRows);
    const type = ext === 'xlsx'
      ? 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
      : 'text/csv;charset=utf-8';
    saveFile(name, body, type);
    setSaved(ext);
  }
  return (
    <details data-section="export" data-fold="export" data-export-enabled={gate.enabled ? 'true' : 'false'} data-export-reason={gate.reason}>
      <summary>落とす</summary>
      <div className="folders-fold-body">
        {gate.enabled ? (
          <p data-export-count={totals.count} data-export-ex={totals.ex}>
            <span>{int(totals.count)}行</span>
            <span>{int(totals.ex)}円</span>
          </p>
        ) : <p className="folders-note" data-export-lock={gate.reason}>{gate.title}</p>}
        <div className="folders-actions">
          <button type="button" disabled={!gate.enabled} data-export="csv" onClick={() => save('csv')}>CSV</button>
          <button type="button" className="secondary" disabled={!gate.enabled} data-export="xlsx" onClick={() => save('xlsx')}>xlsx</button>
        </div>
        {saved && <p role="status" data-export-saved={saved}>{saved}</p>}
        {gate.enabled && (
          <div className="folders-sheet-wrap">
            <table className="folders-sheet">
              <thead><tr>{review.linkedHeaders.map((header) => <th key={header}>{header}</th>)}</tr></thead>
              <tbody>
                {review.linkedRows.map((row, index) => (
                  <tr key={index}>{row.map((cell, cellIndex) => <td key={cellIndex}>{cell}</td>)}</tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </details>
  );
}

function SamplingPanel({sampling, onSampling}) {
  const fixed = sampling === 'fixed' || sampling === 'type' || sampling === 'source';
  return (
    <section data-sampling-panel="true" aria-label="抜き取り">
      <h2>抜き取り</h2>
      <div className="folders-actions">
        <button type="button" aria-pressed={sampling === 'match'} data-sampling="match" onClick={() => onSampling?.('match')}>合っていた</button>
        <button type="button" aria-pressed={fixed} data-sampling="fixed" onClick={() => onSampling?.('fixed')}>直した</button>
      </div>
      {fixed && (
        <fieldset className="folders-void">
          <legend>直し</legend>
          <label><input type="radio" name="sampling-fix" checked={sampling === 'type'} onChange={() => onSampling?.('type')} />型の誤り</label>
          <label><input type="radio" name="sampling-fix" checked={sampling === 'source'} onChange={() => onSampling?.('source')} />原本の誤り</label>
        </fieldset>
      )}
      {sampling ? <p data-sampling-saved={sampling}>{samplingLabel(sampling)}</p> : null}
    </section>
  );
}

export function SourceReview({review, finance = true, sampling = '', onSampling, onBack}) {
  const [events, setEvents] = useState([]);
  const [registeredNow, setRegisteredNow] = useState(false);
  const history = [...review.history, ...events];
  const registered = review.registered || registeredNow;
  function onEvent(event) {
    setEvents((previous) => [...previous, event]);
    if (event.label === '登録') setRegisteredNow(true);
  }
  return (
    <section className="folders folders-review" data-preview-source="folders-preview" data-folders-open="true" data-review-kind={review.kind} data-billed={review.billed ? 'true' : 'false'} data-finance={finance ? 'on' : 'off'}>
      <header className="folders-head">
        <button type="button" className="secondary" onClick={onBack}>戻る</button>
        <span className="folders-mark">見本</span>
        <ol className="folders-path" aria-label="現在地">
          <li>販売管理</li>
          <li>売上報告書</li>
          <li>2026年度</li>
          <li>{review.fileName}</li>
        </ol>
      </header>
      <p className="folders-facts">
        <strong>{review.partner}</strong>
        <span>{review.kindLabel}</span>
        <span>{review.basis}</span>
        <span>計上 {review.recognitionMonth}</span>
        <span>対象 {review.month}</span>
        {review.received && <span>受領 {review.received}</span>}
      </p>
      <section data-section="judgment" aria-label="判定">
        <h2>判定</h2>
        <p className="folders-judgment">
          <strong>{judgmentText(review.judgment)}</strong>
          {review.judgment.tags.map((tag) => <span key={tag} className="folders-tag">{tag}</span>)}
        </p>
      </section>
      <section data-section="numbers" aria-label="数字">
        <h2>数字</h2>
        <div className="folders-num">
          {review.figures.map((row) => (
            <article key={row.label} className={`folders-figure is-${row.tone}`} data-figure={row.label} title={row.tone === 'muted' ? '未確認' : undefined}>
              <strong>{row.label}</strong>
              <span><small>{row.leftName}</small>{amount(row, row.left)}</span>
              <span><small>{row.rightName}</small>{amount(row, row.right)}</span>
              {row.extra != null && <span><small>{row.extraName}</small>{int(row.extra)}</span>}
              <b className="folders-fig-mark">{row.mark}</b>
              {row.tone === 'bad' && row.diff != null && <b data-diff="true">{amount(row, row.diff)}</b>}
            </article>
          ))}
        </div>
        {review.works.length > 0 && (
          <ul className="folders-works" aria-label="作品">
            {review.works.map((work) => (
              <li key={`${work.title}-${work.rows}`} className={`is-${work.tone}`}>
                <strong>{work.title}</strong>
                {work.code && <span>{work.code}</span>}
                <span>{int(work.rows)}行</span>
                <span>{int(work.ex)}円</span>
                <span>計上 {work.month}</span>
                <b>{work.mark}</b>
              </li>
            ))}
          </ul>
        )}
      </section>
      <section data-section="exceptions" aria-label="例外" data-values={review.page ? 'false' : 'true'}>
        <h2>例外</h2>
        {!review.page && (
          <p className="folders-inline-legend">
            <MarkBadge status="inferred" />
            <MarkBadge status="missing" />
          </p>
        )}
        {review.page
          ? (
            <div className="folders-page" data-review-page={review.page.page}>
              <span className="folders-page-no">{review.page.page}</span>
              <span className="folders-tag">PDF</span>
              <strong>要読</strong>
            </div>
          )
          : <SpotList items={review.exceptions} />}
      </section>
      <details data-section="rows" data-fold="rows">
        <summary>全行 <span>{review.rows.length}</span></summary>
        <div className="folders-fold-body">
          {review.rows.length === 0 ? <p>なし</p> : <SpotList items={review.rows} />}
        </div>
      </details>
      <details data-section="history" data-fold="history">
        <summary>履歴</summary>
        <ol className="folders-history">
          {history.map((item) => (
            <li key={`${item.label}-${item.at}`} data-history={item.label}>
              <strong>{item.label}</strong>
              <time dateTime={String(item.at).replace(' ', 'T')}>{item.at}</time>
              <span>{item.who}</span>
              <span>{item.result}</span>
              {item.hash ? <span>{item.hash}</span> : null}
              {item.note ? <span>{item.note}</span> : null}
            </li>
          ))}
        </ol>
      </details>
      <ExportPanel review={review} finance={finance} registered={registered} />
      {review.sampled && <SamplingPanel sampling={sampling} onSampling={onSampling} />}
      <Actions review={review} onEvent={onEvent} />
    </section>
  );
}

export default SourceReview;
