// Excelで一括登録。テンプレート（または現在の登録内容）を出力→記入→読み込み→スプレッドシートで確認→登録。
// 1行でもエラーがあれば登録しない。既存マスタの修正は承認の経路へ回し、この画面では反映しない。
import React, {useEffect, useId, useMemo, useState} from 'react';
import {useShell} from '../shell/context.mjs';
import {Notice} from '../ui/Notice.jsx';
import {labelOf} from '../ui/labels.mjs';
import {int, dateTimeJst} from '../ui/format.mjs';
import {downloadReportXlsx, reportBaseName} from '../xlsx-report.mjs';
import {templateSheets, currentSheets, failedRowSheets} from './bulk-template.mjs';
import {readUpload} from './bulk-read.mjs';
import './bulk-import.css';

const ACTION_LABELS = {insert: '追加', update: '修正', approval: '承認が必要', blocked: '反映しない', unchanged: '変更なし', error: 'エラー'};
const FILTERS = [['all', 'すべて'], ['error', 'エラー'], ['insert', '追加'], ['update', '修正'], ['approval', '承認が必要'], ['unchanged', '変更なし']];

function display(column, value, codes) {
  if (value === null || value === undefined || value === '') return '';
  if (codes && codes[column.key]) return codes[column.key];
  if (column.type === 'select') return labelOf(column.domain, value);
  if (column.type === 'yen' || column.type === 'int') return int(value);
  if (column.type === 'percent') return `${(Number(value) / 100).toFixed(2).replace(/\.00$/, '')}%`;
  return String(value);
}

function PreviewTable({spec, preview, filter}) {
  const shown = preview.rows.filter((row) => filter === 'all' || row.action === filter || (filter === 'approval' && row.action === 'blocked'));
  return (
    <div className="bk-table-wrap">
      <table className="bk-table">
        <thead>
          <tr>
            <th scope="col">行</th>
            <th scope="col">判定</th>
            {spec.columns.map((column) => <th key={column.key} scope="col">{column.header}{column.required && <span className="bk-req" aria-label="必須">*</span>}</th>)}
          </tr>
        </thead>
        <tbody>
          {shown.map((row) => {
            const errorByColumn = new Map(row.errors.map((e) => [e.column, e.message]));
            const changed = new Map(row.changes.map((c) => [c.key, c]));
            return (
              <React.Fragment key={row.rowNo}>
                <tr className={`bk-row is-${row.action}`}>
                  <th scope="row" className="bk-num">{row.rowNo}</th>
                  <td><span className={`bk-badge is-${row.action}`}>{ACTION_LABELS[row.action]}</span></td>
                  {spec.columns.map((column) => {
                    const error = errorByColumn.get(column.header);
                    const change = changed.get(column.key);
                    return (
                      <td key={column.key} className={`${error ? 'bk-cell-error' : ''}${change ? ' bk-cell-changed' : ''}${['yen', 'int'].includes(column.type) ? ' bk-num' : ''}`}
                        title={error || undefined} aria-invalid={error ? 'true' : undefined}>
                        {change && <><del>{display(column, change.before)}</del><span aria-hidden="true"> → </span></>}
                        {display(column, row.values[column.key], row.codes)}
                        {error && <span className="bk-cell-reason">{error}</span>}
                      </td>
                    );
                  })}
                </tr>
                {(row.note || row.errors.some((e) => !e.column)) && (
                  <tr className="bk-row-note"><td colSpan={spec.columns.length + 2}>
                    {row.note}{row.errors.filter((e) => !e.column).map((e) => <span key={e.message} className="bk-error-text">{e.message}</span>)}
                  </td></tr>
                )}
              </React.Fragment>
            );
          })}
        </tbody>
      </table>
      {!shown.length && <p className="rp-muted">この条件の行はありません</p>}
    </div>
  );
}

export function BulkImportPanel({entity, label = '', onCommitted, onNavigate, defaultOpen = false}) {
  const shell = useShell();
  const request = shell.request;
  const go = onNavigate || shell.navigate;
  const id = useId().replace(/:/g, '');
  const [open, setOpen] = useState(defaultOpen);
  const [spec, setSpec] = useState(null);
  const [limits, setLimits] = useState(null);
  const [upload, setUpload] = useState(null);
  const [preview, setPreview] = useState(null);
  const [filter, setFilter] = useState('all');
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState('');
  const noBulk = shell.role === 'production'; // 制作担当はサーバーが一括登録を受け付けない（403）ので入口を出さない
  const [error, setError] = useState(null);
  const [result, setResult] = useState(null);
  const [history, setHistory] = useState([]);

  useEffect(() => {
    if (!open || spec) return;
    request(`/bulk/${entity}/spec`).then((body) => { setSpec(body.spec); setLimits(body.limits); }).catch(setError);
  }, [open, spec, entity, request]);
  const loadHistory = () => request(`/bulk/batches?entity=${entity}`).then((body) => setHistory(body.rows || [])).catch(() => {});
  useEffect(() => { if (open) loadHistory(); }, [open]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    shell.registerUnsaved?.(`bulk-${entity}-${id}`, preview && !result ? 1 : 0, `${spec?.label || ''}の一括登録（確認中）`);
    return () => shell.registerUnsaved?.(`bulk-${entity}-${id}`, 0);
  }, [preview, result]); // eslint-disable-line react-hooks/exhaustive-deps

  async function downloadTemplate() {
    try { downloadReportXlsx(reportBaseName(`${spec.label}_一括登録テンプレート`, '') + '.xlsx', {sheets: templateSheets(spec)}); } catch (cause) { setError(cause); }
  }
  async function downloadCurrent() {
    setBusy('export');
    try {
      const body = await request(`/bulk/${entity}/rows`);
      downloadReportXlsx(reportBaseName(`${spec.label}_現在の登録内容`, '') + '.xlsx', {sheets: currentSheets(body.spec, body.rows)});
    } catch (cause) { setError(cause); } finally { setBusy(''); }
  }
  async function readFile(file) {
    if (!file) return;
    setError(null); setResult(null); setPreview(null); setConfirmed(false); setFilter('all');
    if (limits && file.size > limits.bytes) { setError(new Error(`ファイルが大きすぎます（上限 ${int(Math.round(limits.bytes / 1000))}KB。${limits.reason}）`)); return; }
    setBusy('read');
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      const parsed = readUpload(entity, bytes, file.name);
      if (parsed.meta?.entity && parsed.meta.entity !== entity) throw new Error('このファイルは別の種類（' + parsed.meta.entity + '）のテンプレートです');
      setUpload(parsed);
      const body = await request(`/bulk/${entity}/preview`, {method: 'POST', body: JSON.stringify({fileName: file.name, headers: parsed.headers, rows: parsed.rows, meta: parsed.meta})});
      setPreview(body);
      if (body.summary.error) setFilter('error');
    } catch (cause) { setError(cause); } finally { setBusy(''); }
  }
  async function commit() {
    setBusy('commit'); setError(null);
    try {
      const body = await request(`/bulk/${entity}/commit`, {method: 'POST', body: JSON.stringify({token: preview.token, confirmed: true})});
      setResult(body); setPreview(null); setUpload(null); setConfirmed(false);
      loadHistory();
      onCommitted?.(body);
    } catch (cause) { setError(cause); } finally { setBusy(''); }
  }
  function downloadFailed() {
    try { downloadReportXlsx(reportBaseName(`${spec.label}_失敗行`, '') + '.xlsx', {sheets: failedRowSheets(upload, preview.rows)}); } catch (cause) { setError(cause); }
  }

  const s = preview?.summary;
  const readOnly = Boolean(shell.readOnly);
  if (noBulk) return null;
  return (
    <section className="card bk-panel" aria-labelledby={`bk-${id}`}>
      <header className="bk-head">
        <div>
          <h2 id={`bk-${id}`}>{spec?.label || label}をExcelで一括登録</h2>
          <p className="rp-muted">テンプレートに記入するか、現在の登録内容を出力して行を足し、読み込むと登録前に表で確かめられます。</p>
        </div>
        <button type="button" className={open ? 'secondary' : ''} aria-expanded={open} onClick={() => setOpen((value) => !value)}>{open ? '閉じる' : 'Excelで一括登録'}</button>
      </header>
      {open && (
        <div className="bk-body">
          {error && <Notice error={error} onDismiss={() => setError(null)} />}
          {spec && (
            <>
              <ol className="bk-steps">
                <li>
                  <strong>1. Excelを用意する</strong>
                  <div className="bk-actions">
                    <button type="button" className="secondary" onClick={downloadTemplate}>テンプレートをダウンロード</button>
                    <button type="button" className="secondary" disabled={busy === 'export'} onClick={downloadCurrent}>{busy === 'export' ? '出力中…' : '現在の登録内容をExcelで出力'}</button>
                  </div>
                  <p className="rp-muted">
                    {spec.update === 'approval' ? `既存の${spec.label}の修正は「マスタの表編集」で承認して反映します。ここでは新しい${spec.label}を追加します。` : spec.update === 'direct' ? 'IDを残した行は修正、IDが空欄の行は新規として登録します。' : `既存の${spec.label}はここでは修正できません。`}
                    {limits && `1回に${int(limits.bulkRows)}行まで。`}
                  </p>
                </li>
                <li>
                  <strong>2. ファイルを読み込む</strong>
                  <label className={`bk-drop${busy === 'read' ? ' is-busy' : ''}`}
                    onDragOver={(event) => event.preventDefault()}
                    onDrop={(event) => { event.preventDefault(); if (!readOnly) readFile(event.dataTransfer.files?.[0]); }}>
                    <input type="file" accept=".xlsx,.csv" disabled={readOnly || busy === 'read'} onChange={(event) => { readFile(event.target.files?.[0]); event.target.value = ''; }} />
                    <span>{busy === 'read' ? '読み込み中…' : 'Excel（.xlsx）か CSV をここへドラッグ、または押して選ぶ'}</span>
                  </label>
                </li>
              </ol>
              {preview && (
                <div className="bk-preview">
                  <p className="bk-file">
                    <strong>{upload?.fileName}</strong>（{upload?.sheetName}シート・見出しは{upload?.headerRowNo}行目{upload?.encodingLabel ? `・文字コード ${upload.encodingLabel}` : ''}）
                    {preview.previousBatch && <span className="bk-warn"> 同じ内容を {dateTimeJst(preview.previousBatch.createdAt)} に登録済みです（記録 #{preview.previousBatch.id}）</span>}
                  </p>
                  <div className="bk-summary" role="group" aria-label="判定の件数">
                    {[['insert', s.insert], ['update', s.update], ['approval', s.approval], ['unchanged', s.unchanged], ['error', s.error]].map(([key, count]) => (
                      <button key={key} type="button" className={`bk-count is-${key}${filter === key ? ' is-active' : ''}`} aria-pressed={filter === key} onClick={() => setFilter(filter === key ? 'all' : key)}>
                        <span>{ACTION_LABELS[key]}</span><strong>{int(count)}</strong>
                      </button>
                    ))}
                    <div className="bk-count is-missing"><span>ファイルにない既存行</span><strong>{int(s.missing)}</strong><small>削除しません</small></div>
                  </div>
                  {(preview.ignoredColumns.length > 0 || preview.unknownColumns.length > 0) && (
                    <Notice tone="info" compact message={[
                      preview.ignoredColumns.length ? `参考の列（読み込まない）: ${preview.ignoredColumns.join('、')}` : '',
                      preview.unknownColumns.length ? `見出しが一致しない列（読み込まない）: ${preview.unknownColumns.join('、')}` : '',
                    ].filter(Boolean).join(' ／ ')} />
                  )}
                  <div className="bk-filter" role="group" aria-label="表示する行">
                    {FILTERS.map(([key, label]) => <button key={key} type="button" className="text" aria-pressed={filter === key} onClick={() => setFilter(key)}>{label}</button>)}
                  </div>
                  <PreviewTable spec={spec} preview={preview} filter={filter} />
                  {s.error > 0 ? (
                    <div className="bk-commit">
                      <Notice tone="error" message={`エラーが${s.error}行あるため登録できません。1行でもエラーがあればファイル全体を登録しません。`} />
                      <button type="button" className="secondary" onClick={downloadFailed}>失敗行をExcelで出力（理由つき）</button>
                    </div>
                  ) : preview.canCommit ? (
                    <div className="bk-commit">
                      <label className="rp-inline">
                        <input type="checkbox" checked={confirmed} onChange={(event) => setConfirmed(event.target.checked)} />
                        内容を確認しました（追加 {s.insert}件・修正 {s.update}件を登録します{s.approval ? `。承認が必要な${s.approval}件は反映しません` : ''}）
                      </label>
                      <button type="button" disabled={!confirmed || busy === 'commit' || readOnly} onClick={commit}>{busy === 'commit' ? '登録中…' : `${s.insert + s.update}件を登録する`}</button>
                      <button type="button" className="text" onClick={() => { setPreview(null); setUpload(null); }}>読み込みをやめる</button>
                    </div>
                  ) : (
                    <Notice tone="info" message={s.approval ? `登録する新しい行はありません。承認が必要な修正${s.approval}件は「マスタの表編集」で反映してください。` : '登録する新しい行・修正はありません。'} />
                  )}
                </div>
              )}
              {result && (
                <Notice tone="ok" title={`登録しました（記録 #${result.batch?.id}）`}
                  message={`追加 ${result.summary.insert}件・修正 ${result.summary.update}件。データベースから読み直した先頭${result.saved.length}件: ${result.saved.map((row) => row.code || row.sku || row.id).join('、')}`}
                  actions={result.approvalRows.length > 0 && go ? <button type="button" className="secondary" onClick={() => go('業務データ編集')}>承認が必要な{result.approvalRows.length}件を表編集で反映する</button> : null} />
              )}
              {history.length > 0 && (
                <details className="bk-history">
                  <summary>一括登録の履歴（最近{history.length}件）</summary>
                  <table className="bk-table">
                    <thead><tr><th>記録</th><th>日時</th><th>ファイル</th><th>追加</th><th>修正</th><th>承認待ち</th><th>登録者</th></tr></thead>
                    <tbody>{history.map((batch) => (
                      <tr key={batch.id}><td>#{batch.id}</td><td>{dateTimeJst(batch.created_at)}</td><td>{batch.file_name}</td><td className="bk-num">{batch.inserted_count}</td><td className="bk-num">{batch.updated_count}</td><td className="bk-num">{batch.approval_count}</td><td>{batch.created_by_name}</td></tr>
                    ))}</tbody>
                  </table>
                </details>
              )}
            </>
          )}
        </div>
      )}
    </section>
  );
}

export default BulkImportPanel;
