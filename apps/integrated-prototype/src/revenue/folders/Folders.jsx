// フォルダの見本画面。データは loadSalesReportYear（いまは架空の固定データ）。U2b の受け口にはその関数だけを差し替える。
// UI指針: ../../../../../docs/design/ui-guidelines.md
import React, {useEffect, useRef, useState} from 'react';
import {useShell} from '../../shell/context.mjs';
import {
  CELL_MARKS, CLOSED_MESSAGE, SORT_LABEL, SORT_TITLE, beginDrop, finishDrop, judgmentText, loadReview, loadSalesReportYear, previewHidden, samplingLabel, selectCell,
} from './folders-preview-model.mjs';
import {SourceReview} from './SourceReview.jsx';
import './folders.css';

const MARK_LIST = ['registered', 'missing', 'overdue', 'reading', 'review', 'partial', 'superseded', 'voided'];

export function FoldersClosed() {
  return (
    <section className="folders" data-preview-source="folders-preview" data-folders-open="false">
      <p className="folders-note" role="status">{CLOSED_MESSAGE}</p>
    </section>
  );
}

function FileLine({file, onOpen, mark = ''}) {
  const saved = samplingLabel(mark);
  return (
    <li>
      <button type="button" className="folders-file" data-file={file.name} data-review={file.id} onClick={() => onOpen?.(file.id)}>
        <span>{judgmentText(file.judgment)}</span>
        {file.judgment.tags.map((tag) => <span key={tag} className="folders-tag">{tag}</span>)}
        {saved && <span className="folders-tag" data-sampling-result={mark}>{saved}</span>}
        <span className="folders-file-name">{file.name}</span>
      </button>
    </li>
  );
}

export function FoldersView({
  board, closedMessage = '', dropEffect = null, unknownFile = false, marks = {}, onFolder, onCell, onFile, onOpen,
}) {
  const open = board.folders.find((folder) => folder.openable);
  const selected = board.selection;
  return (
    <section className="folders" data-preview-source={board.source} data-folders-open="true" data-fy={board.fiscalYear}>
      <header className="folders-head">
        <span className="folders-mark">見本</span>
        <span className="folders-mark" title="台帳のフォルダ">{board.folders.length}</span>
        <p className="folders-sort">
          <span>並び </span>
          <strong title={SORT_TITLE}>{SORT_LABEL}</strong>
          <span className="folders-visually-hidden">{SORT_TITLE}</span>
        </p>
      </header>
      {closedMessage && <p className="folders-note" role="status" data-closed-message="true">{closedMessage}</p>}
      <ul className="folders-tree" aria-label="フォルダ">
        {board.folders.map((folder) => (
          <li key={folder.code}>
            <button
              type="button"
              className={`folders-chip${folder.openable ? ' is-current' : ' is-closed'}`}
              aria-pressed={folder.openable}
              title={folder.source === 'unverified' ? '名前は未確認' : folder.name}
              data-folder-code={folder.code}
              data-openable={folder.openable ? 'true' : 'false'}
              onClick={() => onFolder?.(folder)}
            >{folder.name}</button>
          </li>
        ))}
      </ul>
      <ol className="folders-path" aria-label="現在地">
        <li>{open?.name}</li>
        <li>{board.salesReport.name}</li>
        <li>{board.fiscalYear}年度</li>
      </ol>
      <ul className="folders-legend" aria-label="マス">
        {MARK_LIST.map((code) => {
          const mark = CELL_MARKS[code];
          const text = code === 'partial' ? '途 2/6' : mark.mark;
          return <li key={code} className={`is-${mark.tone}`} title={mark.title}><span aria-hidden="true">{text}</span><span className="folders-visually-hidden">{mark.title}</span></li>;
        })}
      </ul>
      {unknownFile && <p className="folders-note" role="status" data-unknown-file="true">未確認</p>}
      {dropEffect && (
        <p className="folders-note" role="status" data-drop-effect={dropEffect.code} title={dropEffect.title}>
          {dropEffect.code === 'duplicate' ? dropEffect.label : dropEffect.title}
        </p>
      )}
      <div className="folders-year">
        {board.rows.map((row) => {
          const rowOpen = selected?.rowId === row.id;
          return (
            <article key={row.id} className="folders-row" data-partner={row.id}>
              <div className="folders-row-head">
                <div className="folders-who">
                  <strong>{row.partner}</strong>
                  <span>{row.kind}</span>
                  <span title="計上の基準">{row.basis}</span>
                </div>
                <label
                  className={`folders-drop${rowOpen ? ' is-open' : ''}`}
                  data-drop={row.id}
                  onDragOver={(event) => event.preventDefault()}
                  onDrop={(event) => {
                    event.preventDefault();
                    const file = event.dataTransfer?.files?.[0];
                    if (file) onFile?.(row.id, file.name);
                  }}
                >
                  置く
                  <input
                    className="folders-visually-hidden"
                    type="file"
                    accept=".xlsx,.csv,.pdf"
                    aria-label={`${row.partner}へ置く`}
                    onChange={(event) => {
                      const file = event.target.files?.[0];
                      if (file) onFile?.(row.id, file.name);
                      event.target.value = '';
                    }}
                  />
                </label>
              </div>
              <div className="folders-months">
                {row.cells.map((cell) => (
                  <button
                    key={cell.month}
                    type="button"
                    className={`folders-cell is-${cell.tone}${selected?.rowId === row.id && selected?.month === cell.month ? ' is-selected' : ''}`}
                    title={cell.title}
                    aria-label={`${cell.label} ${cell.mark}`}
                    data-cell={cell.code}
                    data-month={cell.month}
                    onClick={() => onCell?.(row.id, cell.month)}
                  >{cell.mark}</button>
                ))}
              </div>
              {row.files.length > 0 && (
                <ul className="folders-files" aria-label="原本">
                  {row.files.map((file) => <FileLine key={file.id} file={file} onOpen={onOpen} mark={marks[file.id]} />)}
                </ul>
              )}
            </article>
          );
        })}
      </div>
      <section className="folders-sampling" aria-label="抜き取り">
        <h2>抜き取り</h2>
        <ul className="folders-files">
          {board.rows.flatMap((row) => row.files).filter((file) => file.sampling).map((file) => <FileLine key={file.id} file={file} onOpen={onOpen} mark={marks[file.id]} />)}
        </ul>
      </section>
    </section>
  );
}

export function Folders() {
  const shell = useShell();
  const hidden = previewHidden(shell.viewMode);
  const fyParam = shell.getParam('fy');
  const fileId = shell.getParam('file');
  const [board, setBoard] = useState(() => loadSalesReportYear({fiscalYear: /^\d{4}$/.test(String(fyParam || '')) ? Number(fyParam) : null}));
  const [closedMessage, setClosedMessage] = useState('');
  const [dropEffect, setDropEffect] = useState(null);
  const [marks, setMarks] = useState({});
  const timer = useRef(null);
  const boardRef = useRef(board);
  boardRef.current = board;

  useEffect(() => () => clearTimeout(timer.current), []);
  useEffect(() => {
    if (!/^\d{4}$/.test(String(fyParam || ''))) return;
    const year = Number(fyParam);
    if (year !== boardRef.current.fiscalYear) setBoard(loadSalesReportYear({fiscalYear: year}));
  }, [fyParam]);

  function onFolder(folder) {
    setDropEffect(null);
    setClosedMessage(folder.openable ? '' : CLOSED_MESSAGE);
  }
  function onCell(rowId, month) {
    setBoard(selectCell(boardRef.current, {rowId, month}));
    setClosedMessage('');
  }
  function onFile(rowId, fileName) {
    const result = beginDrop(boardRef.current, {rowId, fileName, month: boardRef.current.selection?.rowId === rowId ? boardRef.current.selection.month : null});
    setBoard(result.board);
    setDropEffect(result.effect);
    setClosedMessage('');
    clearTimeout(timer.current);
    if (result.effect?.code === 'reading') {
      const pendingBoard = result.board;
      timer.current = setTimeout(() => {
        setBoard(finishDrop(pendingBoard));
        setDropEffect({code: 'review', label: '要', title: '要確認'});
      }, 1200);
    }
  }

  if (hidden) return <FoldersClosed />;
  const review = fileId ? loadReview(fileId) : null;
  if (review) {
    return (
      <SourceReview
        key={review.id}
        review={review}
        finance={shell.role === 'admin'}
        sampling={marks[review.id] || ''}
        onSampling={(value) => setMarks((previous) => ({...previous, [review.id]: value}))}
        onBack={() => shell.setParam('file', null)}
      />
    );
  }
  return (
    <FoldersView
      board={board}
      marks={marks}
      closedMessage={closedMessage}
      dropEffect={dropEffect}
      unknownFile={Boolean(fileId)}
      onFolder={onFolder}
      onCell={onCell}
      onFile={onFile}
      onOpen={(id) => shell.setParam('file', id)}
    />
  );
}

export default Folders;
