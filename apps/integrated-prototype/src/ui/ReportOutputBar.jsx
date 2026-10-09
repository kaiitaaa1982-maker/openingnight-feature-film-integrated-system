// 帳票・一覧の出力ボタン。文言は全画面で「Excel」「CSV」「印刷・PDF」「印刷用HTML」にそろえる。
// sheets は出力時に呼ぶ関数（xlsx-report.mjs のシート定義の配列を返す）。配列をそのまま渡してもよい。
// シートが複数あるとき、CSV は1枚を、印刷は全シートか1枚を、その場で選んでから出力する。
import React, {useState} from 'react';
import {exportReport} from '../report-output.mjs';
import {reportBaseName} from '../xlsx-report.mjs';
import './data-grid.css';

export const OUTPUT_LABELS = Object.freeze({xlsx: 'Excel', csv: 'CSV', print: '印刷・PDF', html: '印刷用HTML'});
const ORDER = ['xlsx', 'csv', 'print', 'html'];

export function ReportOutputBar({sheets, name, period, formats = ORDER, title, subtitle, disabled = false, onError, label = '出力'}) {
  const [pending, setPending] = useState(null);
  const [error, setError] = useState('');

  function fail(cause) {
    const message = cause?.message || '出力できませんでした';
    setError(message);
    onError?.(cause);
  }

  function resolveSheets() {
    const list = typeof sheets === 'function' ? sheets() : sheets;
    if (!Array.isArray(list) || !list.length) throw Error('出力する表がありません');
    return list;
  }

  function run(format, list, sheetIndex) {
    setError('');
    try {
      const first = list[0] || {};
      const filename = reportBaseName(name || first.title || first.name, period);
      exportReport(format, {filename, title: title ?? first.title ?? name, subtitle, sheets: list, sheetIndex, generatedAt: new Date().toISOString()});
    } catch (cause) {
      fail(cause);
    }
  }

  function start(format) {
    let list;
    try { list = resolveSheets(); } catch (cause) { fail(cause); return; }
    if (format !== 'xlsx' && list.length > 1) {
      setPending({format, list, choice: format === 'csv' ? '0' : 'all'});
      return;
    }
    setPending(null);
    run(format, list, format === 'csv' ? 0 : undefined);
  }

  function confirmChoice() {
    const {format, list, choice} = pending;
    setPending(null);
    run(format, list, choice === 'all' ? undefined : Number(choice));
  }

  const shown = ORDER.filter((format) => formats.includes(format));
  return (
    <div className="report-output" role="group" aria-label={label}>
      <div className="report-output-buttons">
        {shown.map((format) => (
          <button key={format} type="button" className="secondary" disabled={disabled} onClick={() => start(format)}>
            {OUTPUT_LABELS[format]}
          </button>
        ))}
      </div>
      {pending && (
        <div className="report-output-choice">
          <label>
            {pending.format === 'csv' ? 'CSVにするシート' : '印刷するシート'}
            <select value={pending.choice} onChange={(event) => setPending({...pending, choice: event.target.value})}>
              {pending.format !== 'csv' && <option value="all">すべてのシート</option>}
              {pending.list.map((sheet, index) => <option key={index} value={String(index)}>{sheet.name || sheet.title || `シート${index + 1}`}</option>)}
            </select>
          </label>
          <button type="button" onClick={confirmChoice}>{OUTPUT_LABELS[pending.format]}で出力</button>
          <button type="button" className="secondary" onClick={() => setPending(null)}>閉じる</button>
        </div>
      )}
      {error && <p className="report-output-error" role="alert">{error}</p>}
    </div>
  );
}

export default ReportOutputBar;
