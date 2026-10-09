// 通知。成否は明示の tone（ok/error/warn/info）でだけ決める（本文の文字から色を推測しない）。
// error は role=alert、ほかは role=status。details:[{row, column, message}] を表で出す。
// error に例外を渡すと describeError の日本語文・行の詳細・技術情報（折りたたみ）を組み立てる。
// 使い方: <Notice tone="ok" message="登録しました" /> ／ <Notice error={e} onRetry={load} />
import React from 'react';
import {errorNotice, normalizeDetails} from './api-client.mjs';
import './forms.css';

const TONE_LABEL = Object.freeze({ok: '完了', error: 'エラー', warn: '注意', info: 'お知らせ'});
const TONES = Object.keys(TONE_LABEL);

export function Notice({
  tone, message, title, details, error, technical, onRetry, retryLabel = '再試行', onDismiss, actions, children, id, className = '', compact = false,
}) {
  const fromError = error ? errorNotice(error) : null;
  const resolvedTone = TONES.includes(tone) ? tone : fromError ? 'error' : 'info';
  const text = message ?? fromError?.message ?? '';
  const rows = details !== undefined ? normalizeDetails(details) : fromError?.details ?? [];
  const tech = technical ?? fromError?.technical ?? '';
  if (!text && !title && !children && !rows.length) return null;
  const hasRow = rows.some((row) => row.row !== null && row.row !== undefined);
  const hasColumn = rows.some((row) => row.column !== null && row.column !== undefined);
  return (
    <div id={id} className={`on-notice on-notice-${resolvedTone}${compact ? ' on-notice-compact' : ''} ${className}`.trim()}
      role={resolvedTone === 'error' ? 'alert' : 'status'}>
      <div className="on-notice-body">
        <span className="on-notice-tone">{TONE_LABEL[resolvedTone]}</span>
        <div className="on-notice-text">
          {title && <strong className="on-notice-title">{title}</strong>}
          {text && <p>{text}</p>}
          {children}
        </div>
        {(onRetry || onDismiss || actions) && (
          <div className="on-notice-actions">
            {actions}
            {onRetry && <button type="button" className="secondary" onClick={onRetry}>{retryLabel}</button>}
            {onDismiss && <button type="button" className="text" onClick={onDismiss}>閉じる</button>}
          </div>
        )}
      </div>
      {rows.length > 0 && (
        <div className="on-notice-details">
          <p className="on-notice-count">{rows.length.toLocaleString('ja-JP')}件</p>
          <div className="on-notice-table">
            <table>
              <thead>
                <tr>
                  {hasRow && <th scope="col">行</th>}
                  {hasColumn && <th scope="col">列</th>}
                  <th scope="col">内容</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row, index) => (
                  <tr key={index}>
                    {hasRow && <td className="num">{row.row ?? '—'}</td>}
                    {hasColumn && <td>{row.column ?? '—'}</td>}
                    <td>{row.message}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
      {tech && (
        <details className="on-notice-tech">
          <summary>技術情報</summary>
          <pre>{tech}</pre>
        </details>
      )}
    </div>
  );
}

export default Notice;
