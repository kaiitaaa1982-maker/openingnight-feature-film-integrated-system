// 表編集（業務データ編集・売上データ編集）。作品・商品・取引先・売上取込の表を下書きで直し、加工手順を確かめ、
// 全件を検証して承認申請→承認→反映する。表は Excel と同じ手つき（閲覧／編集の2モード）で操作する。
// 操作の論理は workbench-ui.mjs の純関数（試験: test/workbench-grid-keys.test.mjs）。API は props の request だけを使う。
import React, {useEffect, useMemo, useRef, useState} from 'react';
import {flushSync} from 'react-dom';
import './workbench-ui.css';
import './workbench-extra.css';
import {
  FALLBACK, OPS, DATASET_SCOPES, SALES_DERIVED, STAGE_STATE_TEXT, WB_PAGE_SIZE,
  applyEdits, cellEditable, cellErrorKey, cellIssue, clearCells, datasetAccess, deleteRowsByKeys, deriveSalesValues, diffRows, draftLabel,
  editableStep, ensureRowKeys, fillDown, gridCellText, gridColumns, gridKeyAction, inRectangle, insertRow, mapRowErrors,
  moveSelection, newSalesRow, normalize, normalizeCellInput, pasteCells, rectangle, rowNumbers, rowsFromSheet, selectedRowKeys,
  setCells, show, sourceKey, statusText, step, tsvFor, unsavedCount, workbenchSheet, workflowState,
} from './workbench-ui.mjs';
import {suggestSalesImportFormats} from './import-format.mjs';
import {channelSalesColumns, channelSalesGroups} from './channel-sales.mjs';
import {useShell} from './shell/context.mjs';
import {Notice} from './ui/Notice.jsx';
import {labelOf} from './ui/labels.mjs';
import {dateTimeJst, int as formatInt} from './ui/format.mjs';
import {isApiError} from './ui/api-client.mjs';
import {downloadReportXlsx, reportBaseName, specTable} from './xlsx-report.mjs';
import {csvDocument, downloadDocument} from './report-output.mjs';

const clone = (value) => structuredClone(value);
const uid = () => globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2)}`;
const UNSAVED_ID = 'workbench';
const HIDDEN_GRID_KEYS = new Set(['id', 'project_id', 'version']);
// 反映の再送キー。応答が途切れたときに同じキーで結果を取り直す（この画面を開いている間だけ保持する）。
const applyKeys = new Map();

const STEP_SHAPES = {select: ['columns'], rename: ['from', 'to'], type: ['column', 'type'], filter: ['column', 'operator', 'value', 'valueType'], replace: ['column', 'from', 'to', 'valueType'], split: ['column', 'delimiter', 'into'], concat: ['columns', 'separator', 'into'], calculate: ['columns', 'operator', 'constant', 'into'], sort: ['column', 'direction'], join: ['lookup', 'leftKey', 'rightKey', 'columns', 'kind', 'prefix'], append: ['dataset'], dedupe: ['columns', 'keep'], group: ['by', 'aggregateColumn', 'aggregate', 'into'], pivot: ['by', 'keyColumn', 'valueColumn'], unpivot: ['fixed', 'columns', 'keyInto', 'valueInto']};
const STEP_OPTIONS = {
  type: [['string', '文字'], ['integer', '整数'], ['number', '数値'], ['boolean', 'はい・いいえ'], ['date', '日付']],
  valueType: [['string', '文字'], ['number', '数値'], ['boolean', 'はい・いいえ']],
  operator: [['eq', '等しい'], ['neq', '等しくない'], ['contains', '含む'], ['gt', 'より大きい'], ['gte', '以上'], ['lt', 'より小さい'], ['lte', '以下']],
  direction: [['asc', '昇順'], ['desc', '降順']],
  kind: [['left', '元の表の行をすべて残す'], ['inner', '一致した行だけ残す']],
  keep: [['first', '最初の行を残す'], ['error', 'エラーにする']],
  aggregate: [['sum', '合計'], ['count', '件数'], ['min', '最小'], ['max', '最大'], ['avg', '平均']],
  operation: [['add', '足す'], ['subtract', '引く'], ['multiply', '掛ける'], ['divide', '割る']],
};
const STEP_LABELS = {columns: '対象列（カンマ区切り）', column: '対象列', from: '変更前', to: '変更後', type: '変換後の型', operator: '条件・計算', value: '比較する値', valueType: '値の型', delimiter: '区切り文字', into: '出力列名', separator: '連結文字', constant: '定数', direction: '順序', lookup: '参照表', leftKey: '元表のキー', rightKey: '参照表のキー', kind: '結合方法', prefix: '列名の接頭辞', dataset: '追加する表', keep: '重複時の処理', by: '集計する単位', aggregateColumn: '集計対象列', aggregate: '集計方法', keyColumn: '見出しにする列', valueColumn: '値にする列', fixed: '固定する列', keyInto: '項目名の出力列', valueInto: '値の出力列'};
const CONTROL_FIELDS = [['rowCount', '明細件数'], ['amountExTax', '税抜合計'], ['taxAmount', '税額合計'], ['amountIncTax', '税込合計']];
const KIND_LABELS = {theatrical: '劇場', package: 'ビデオグラム', digital: '配信', broadcast: '放送', other: 'その他'};
const CONFIDENCE_LABELS = {high: '高い', medium: '中程度', low: '低い（人が確かめてください）', none: '判定できません'};
// 施錠したデータセットの閲覧先（業務の画面）。
const VIEW_PAGES = {works: '作品・商品マスタ', products: '作品・商品マスタ', partners: '取引先', sales_import: '売上'};
const GRID_HINT = 'セルを選んでそのまま入力できます。Enter・F2で編集／Escで取消／Enter・Tabで確定して下・右へ／Deleteで消去／Ctrl+Zで元に戻す／Ctrl+Yでやり直す／Ctrl+Dで上の値を下へ写す／Excelからの貼り付けもできます';

const entered = (values) => Object.fromEntries(Object.entries(values).filter(([, value]) => String(value ?? '').trim() !== ''));
const formValues = (values) => Object.fromEntries(Object.entries(values || {}).filter(([, value]) => value != null).map(([k, value]) => [k, String(value)]));
function restoredSalesInputs(validation) {
  const changes = validation?.changes || {};
  const {byChannel, ...sourceTotals} = changes.sourceTotals || {};
  return {
    sourceTotals: formValues(sourceTotals),
    channelTotals: formValues(changes.channelTotals || byChannel?.[changes.kind] || {}),
    sourceIdentifierColumns: formValues(changes.sourceIdentifierColumns),
    formatConfirmed: changes.formatConfirmed === true,
  };
}
const isTextEditor = (column) => ['text', 'yen', 'int', 'number', 'id'].includes(column?.kind);
function editorValue(column, value) {
  if (value === null || value === undefined) return '';
  if (column.kind === 'date' || column.kind === 'month') {
    const normalized = normalizeCellInput(column, value);
    const pattern = column.kind === 'date' ? /^\d{4}-\d{2}-\d{2}$/ : /^\d{4}-\d{2}$/;
    return pattern.test(String(normalized)) ? String(normalized) : '';
  }
  return show(value);
}
function columnWidth(column) {
  if (column.kind === 'id') return 84;
  if (column.numeric) return 118;
  if (column.kind === 'date' || column.kind === 'month') return 124;
  if (column.kind === 'select' || column.kind === 'lookup') return 170;
  return 160;
}

// ── 原本照合（売上取込） ─────────────────────────────────────────────────────
function ImportPreflight({suggestion, confirmed, setConfirmed, controls, setControls, channelControls, setChannelControls, idColumns, setIdColumns, validation, locked}) {
  const controlInput = (fields, values, setValues) => (
    <div className="wb-control-grid">
      {fields.map(([key, label]) => (
        <label key={key}>{label}
          <input inputMode="numeric" disabled={locked} value={values[key] ?? ''} onChange={(event) => setValues({...values, [key]: event.target.value})} placeholder="原本に記載があれば入力" />
        </label>
      ))}
    </div>
  );
  const preflight = validation?.changes?.preflight;
  return (
    <section className="wb-import-preflight" aria-label="取込形式と原本照合">
      <h3>取込形式と原本照合</h3>
      {suggestion
        ? <>
          <p>候補: <b>{suggestion.candidates[0]?.label || '判定できません'}</b>（確からしさ: {CONFIDENCE_LABELS[suggestion.confidence] || '判定できません'}）</p>
          <p>{suggestion.reason}</p>
          {suggestion.candidates.slice(0, 3).map((item) => <small key={item.kind}>{item.label}: {item.evidence.map((e) => e.signal).join('・')}</small>)}
        </>
        : <p>原本の見出し行を取り込むと、販路の候補と根拠を表示します。</p>}
      <label className="wb-confirm">
        <input type="checkbox" disabled={locked} checked={confirmed} onChange={(event) => setConfirmed(event.target.checked)} />原本の形式と各行の報告種別を確認した
      </label>
      <details>
        <summary>原本に明記された件数・合計を照合する</summary>
        <p>推測した合計は入力せず、原本に記載された値だけを入力してください。</p>
        {controlInput(CONTROL_FIELDS, controls, setControls)}
        <h4>販路別の集計がある場合</h4>
        {controlInput(CONTROL_FIELDS, channelControls, setChannelControls)}
        <h4>原本の識別列の見出し</h4>
        {[['report_key', '報告キー'], ['partner_id', '取引先ID'], ['product_id', '商品ID']].map(([key, label]) => (
          <label key={key}>{label}<input disabled={locked} value={idColumns[key] || ''} onChange={(event) => setIdColumns({...idColumns, [key]: event.target.value})} placeholder="原本の列見出し" /></label>
        ))}
      </details>
      {preflight && (
        <details open={preflight.status === 'blocked'}>
          <summary>照合結果: {labelOf('checkStatus', preflight.status)}</summary>
          {preflight.checks.map((check) => (
            <p key={check.key} className={check.status === 'fail' ? 'wb-bad' : ''}><b>{labelOf('checkStatus', check.status)}</b> {check.message}</p>
          ))}
        </details>
      )}
    </section>
  );
}

// ── 加工手順の入力 ──────────────────────────────────────────────────────────
function Param({value, onChange, cols, datasets, disabled}) {
  const parameters = value.parameters || {};
  const change = (key, next) => onChange({...value, parameters: {...parameters, [key]: next}});
  return (
    <div className="step-form">
      {(STEP_SHAPES[value.operation] || []).map((key) => {
        const choices = value.operation === 'calculate' && key === 'operator' ? STEP_OPTIONS.operation : STEP_OPTIONS[key];
        let control;
        if (choices) {
          control = (
            <select disabled={disabled} value={parameters[key] || ''} onChange={(event) => change(key, event.target.value)}>
              <option value="">選択</option>
              {choices.map(([code, label]) => <option key={code} value={code}>{label}</option>)}
            </select>
          );
        } else if (key === 'lookup' || key === 'dataset') {
          control = (
            <select disabled={disabled} value={parameters[key] || ''} onChange={(event) => change(key, event.target.value)}>
              <option value="">選択</option>
              {datasets.map((d) => <option key={d.key} value={d.key}>{d.label}</option>)}
            </select>
          );
        } else {
          control = <input disabled={disabled} value={parameters[key] ?? ''} list="wb-cols" onChange={(event) => change(key, event.target.value)} />;
        }
        return <label key={key}>{STEP_LABELS[key] || key}{control}</label>;
      })}
      <datalist id="wb-cols">{cols.map((c) => <option key={c.key} value={c.key}>{c.label}</option>)}</datalist>
    </div>
  );
}

// ── 段階表示と次の操作 ──────────────────────────────────────────────────────
function StageBar({flow, busy, onNext}) {
  const next = flow.next;
  return (
    <div className="wb-stagebar">
      <ol className="wb-stages" aria-label="作業の段階">
        {flow.stages.map((stage) => (
          <li key={stage.id} className={`is-${stage.state}`} aria-current={stage.state === 'current' ? 'step' : undefined}>
            <span className="wb-stage-label">{stage.label}</span>
            <span className="wb-stage-state">{STAGE_STATE_TEXT[stage.state]}</span>
          </li>
        ))}
      </ol>
      <div className="wb-next">
        <span className="wb-next-title">次の操作</span>
        {next.action
          ? <button type="button" disabled={!next.enabled || Boolean(busy)} onClick={() => onNext(next.action)}>{busy ? `${busy}中…` : next.label}</button>
          : <strong className="wb-next-wait">{next.label}</strong>}
        {next.reason && <small>{next.reason}</small>}
      </div>
    </div>
  );
}

// ── 編集中のセルの入力欄 ────────────────────────────────────────────────────
function CellEditor({column, value, onChange, onBlur, inputRef, label}) {
  const common = {ref: inputRef, className: 'wb-editor', value, 'aria-label': `${label}を編集`, onChange: (event) => onChange(event.target.value), onBlur};
  if (column.kind === 'select' || column.kind === 'lookup') {
    const known = (column.options || []).some((option) => option.value === String(value));
    return (
      <select {...common}>
        <option value="">（空欄）</option>
        {!known && value !== '' && <option value={value}>{gridCellText(column, value)}</option>}
        {(column.options || []).map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
      </select>
    );
  }
  if (column.kind === 'date') return <input {...common} type="date" />;
  if (column.kind === 'month') return <input {...common} type="month" />;
  return <input {...common} type="text" inputMode={column.numeric || column.kind === 'id' ? 'numeric' : undefined} autoComplete="off" spellCheck={false} />;
}

// ── 表（閲覧モード／編集モード） ──────────────────────────────────────────────
function Grid({rows, keys, numbers, columns, selection, setSelection, readOnly, errorCells, issues, rowErrors, onCommit, onAction, label, focusRequest}) {
  const box = useRef(null);
  const inputRef = useRef(null);
  const drag = useRef(false);
  const wantFocus = useRef(false);
  const finished = useRef(false);
  const [editing, setEditing] = useState(null);
  const rect = rectangle(selection?.anchor, selection?.focus);
  const active = selection?.focus || null;
  const signature = `${keys.join('\u0001')}\u0002${columns.map((c) => `${c.key}:${c.editable}`).join(',')}`;

  useEffect(() => { setEditing(null); }, [signature]);
  useEffect(() => {
    const stop = () => { drag.current = false; };
    window.addEventListener('mouseup', stop);
    return () => window.removeEventListener('mouseup', stop);
  }, []);
  useEffect(() => { if (focusRequest) wantFocus.current = true; }, [focusRequest]);
  useEffect(() => {
    if (editing) {
      const input = inputRef.current;
      if (input && document.activeElement !== input) {
        input.focus();
        if (typeof input.setSelectionRange === 'function' && input.type === 'text') {
          try { input.setSelectionRange(input.value.length, input.value.length); } catch { /* 選択範囲を持てない入力欄 */ }
        }
      }
      return;
    }
    if (!wantFocus.current || !active) return;
    wantFocus.current = false;
    box.current?.querySelector(`[data-cell="${active.r}:${active.c}"]`)?.focus();
  });

  const bounds = {rows: rows.length, cols: columns.length};
  const startEdit = (r, c, {keep = true, text = ''} = {}) => {
    const column = columns[c];
    if (readOnly || !column || !rows[r] || !cellEditable(column, rows[r])) {
      onAction({type: 'readonly', column});
      return false;
    }
    finished.current = false;
    setEditing({r, c, key: keys[r], field: column.key, value: keep ? editorValue(column, rows[r][column.key]) : text});
    return true;
  };
  const finish = (move) => {
    if (!editing || finished.current) return;
    finished.current = true;
    const column = columns[editing.c];
    onCommit(editing.key, editing.field, normalizeCellInput(column, editing.value));
    setEditing(null);
    wantFocus.current = true;
    if (move) setSelection((current) => moveSelection(current, {type: 'commit', ...move}, bounds));
  };
  const cancel = () => {
    finished.current = true;
    setEditing(null);
    wantFocus.current = true;
  };

  const onKeyDown = (event) => {
    if (editing) {
      const action = gridKeyAction(event, {editing: true});
      if (action.type === 'cancel') {
        event.preventDefault();
        cancel();
      } else if (action.type === 'commit') {
        event.preventDefault();
        finish({dr: action.dr, dc: action.dc});
      }
      return;
    }
    if (!rows.length || !columns.length) return;
    const focus = active || {r: 0, c: 0};
    const column = columns[focus.c];
    const writable = !readOnly && column && rows[focus.r] ? cellEditable(column, rows[focus.r]) : false;
    // 日本語入力の開始: 文字の列なら入力欄を開き、変換中の文字をそのまま受ける
    if ((event.keyCode === 229 || event.key === 'Process') && writable && isTextEditor(column)) {
      flushSync(() => startEdit(focus.r, focus.c, {keep: false, text: ''}));
      inputRef.current?.focus();
      return;
    }
    const action = gridKeyAction(event, {editing: false, readOnly});
    switch (action.type) {
      case 'none':
      case 'copy':
      case 'paste':
        return; // コピー・貼付は copy / paste イベントで扱う
      case 'edit': {
        if (!writable) {
          event.preventDefault();
          onAction({type: 'readonly', column});
          return;
        }
        if (!action.keep && !isTextEditor(column)) {
          // 日付・月・選択肢は入力欄を開き、打った文字は入力欄の既定の動作に任せる
          flushSync(() => startEdit(focus.r, focus.c, {keep: true}));
          inputRef.current?.focus();
          return;
        }
        event.preventDefault();
        startEdit(focus.r, focus.c, action.keep ? {keep: true} : {keep: false, text: action.text});
        return;
      }
      case 'move':
        // 右端・左端での Tab は表の外へ移る（キーボードだけで表から出られるように）
        if (event.key === 'Tab' && ((action.dc > 0 && focus.c >= columns.length - 1) || (action.dc < 0 && focus.c <= 0))) return;
      // fallthrough
      case 'moveTo':
      case 'selectAll':
      case 'collapse':
        event.preventDefault();
        wantFocus.current = true;
        setSelection((current) => moveSelection(current || {anchor: focus, focus}, action, bounds));
        return;
      default:
        event.preventDefault();
        onAction(action);
    }
  };
  const onCopy = (event) => {
    if (editing || !rect) return;
    event.preventDefault();
    event.clipboardData.setData('text/plain', tsvFor(rows, columns, rect));
  };
  const onPaste = (event) => {
    if (editing) return;
    event.preventDefault();
    onAction({type: 'pasteText', text: event.clipboardData.getData('text/plain')});
  };
  const select = (r, c, extend) => {
    wantFocus.current = true;
    setSelection((current) => (extend && current?.anchor ? {anchor: current.anchor, focus: {r, c}} : {anchor: {r, c}, focus: {r, c}}));
  };
  const tabStop = active || {r: 0, c: 0};

  return (
    <div ref={box} className="wb-grid-wrap" role="grid" aria-label={label} aria-rowcount={rows.length + 1} aria-colcount={columns.length + 1} aria-multiselectable="true"
      onKeyDown={onKeyDown} onCopy={onCopy} onPaste={onPaste}>
      <table className="wb-grid">
        <thead>
          <tr role="row">
            <th scope="col" className="wb-rowhead" role="columnheader">行</th>
            {columns.map((column, c) => (
              <th key={column.key} scope="col" role="columnheader" className={`${column.numeric ? 'num ' : ''}${c === 0 ? 'is-first' : ''}`} style={{minWidth: columnWidth(column)}}
                title={column.derived ? SALES_DERIVED[column.key] : undefined}>
                {column.label}
                {column.derived ? <small className="wb-col-note">計算</small> : !column.editable && !readOnly ? <small className="wb-col-note">読取</small> : null}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, r) => {
            const rowKey = keys[r];
            const messages = rowErrors.get(rowKey);
            const number = numbers.get(rowKey) ?? r + 1;
            const sourceRow = Number.isInteger(row?._source?.row) ? row._source.row : null;
            return (
              <tr key={rowKey} role="row" className={messages ? 'has-error' : ''}>
                <th scope="row" role="rowheader" className="wb-rowhead" title={sourceRow ? `原本の${sourceRow}行目` : undefined}
                  onMouseDown={(event) => {
                    if (event.button !== 0) return;
                    event.preventDefault();
                    wantFocus.current = true;
                    setSelection((current) => (event.shiftKey && current?.anchor
                      ? {anchor: {r: current.anchor.r, c: columns.length - 1}, focus: {r, c: 0}}
                      : {anchor: {r, c: columns.length - 1}, focus: {r, c: 0}}));
                  }}>
                  {number}{messages && <span className="wb-row-flag" aria-label={`エラー${messages.length}件`}>!</span>}
                </th>
                {columns.map((column, c) => {
                  const value = row[column.key];
                  const isActive = active?.r === r && active?.c === c;
                  const isEditing = editing?.r === r && editing?.c === c;
                  const cellKey = cellErrorKey(rowKey, column.key);
                  const error = errorCells.get(cellKey);
                  const issue = !error ? issues.get(cellKey) : null;
                  const text = gridCellText(column, value);
                  const selected = inRectangle(r, c, rect);
                  const writable = !readOnly && cellEditable(column, row);
                  const className = [column.numeric ? 'num' : '', c === 0 ? 'is-first' : '', selected ? 'is-selected' : '', isActive ? 'is-active' : '',
                    error ? 'is-error' : '', issue ? 'is-issue' : '', writable ? '' : 'is-readonly'].filter(Boolean).join(' ');
                  const tabbable = tabStop.r === r && tabStop.c === c;
                  return (
                    <td key={column.key} role="gridcell" data-cell={`${r}:${c}`} tabIndex={tabbable && !isEditing ? 0 : -1} className={className}
                      aria-selected={selected} aria-readonly={!writable || undefined} aria-invalid={error ? true : undefined}
                      aria-label={`${number}行目 ${column.label}: ${text || '空欄'}${error ? `。エラー: ${error}` : issue ? `。注意: ${issue}` : ''}`}
                      title={error || issue || (column.derived && !writable ? SALES_DERIVED[column.key] : undefined)}
                      onMouseDown={(event) => {
                        if (event.button !== 0 || isEditing) return;
                        drag.current = true;
                        select(r, c, event.shiftKey);
                      }}
                      onMouseEnter={() => { if (drag.current) setSelection((current) => ({anchor: current?.anchor || {r, c}, focus: {r, c}})); }}
                      onDoubleClick={() => startEdit(r, c, {keep: true})}>
                      {isEditing
                        ? <CellEditor column={column} value={editing.value} inputRef={inputRef} label={`${number}行目 ${column.label}`}
                          onChange={(next) => setEditing((current) => (current ? {...current, value: next} : current))}
                          onBlur={() => finish(null)} />
                        : <span className="wb-cell-text">{text}</span>}
                      {error && !isEditing && <span className="wb-cell-flag" aria-hidden="true">!</span>}
                    </td>
                  );
                })}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

// ── 検証エラーの一覧（行・列・理由。押すとそのセルへ移る） ─────────────────────
function ErrorList({errors, onJump}) {
  if (!errors?.items?.length) return null;
  return (
    <div className="wb-errors" role="region" aria-label="検証エラーの一覧">
      <table>
        <thead><tr><th scope="col">行</th><th scope="col">原本の行</th><th scope="col">列</th><th scope="col">内容</th><th scope="col"><span className="wb-sr">移動</span></th></tr></thead>
        <tbody>
          {errors.items.slice(0, 200).map((item, index) => (
            <tr key={index}>
              <td className="num">{item.gridRow ? `${item.gridRow}行目` : '表全体'}</td>
              <td className="num">{item.sourceRow ? `${item.sourceRow}行目` : '—'}</td>
              <td>{item.columnLabel || '—'}</td>
              <td>{item.message}</td>
              <td>{item.rowKey && <button type="button" className="secondary wb-small" onClick={() => onJump(item.rowKey, item.column)}>セルへ移る</button>}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {errors.items.length > 200 && <p className="wb-muted">ほか{formatInt(errors.items.length - 200)}件。表の「!」の行で確かめられます。</p>}
    </div>
  );
}

function changeText(item, columns) {
  if (item.kind === '追加') return '新しい行';
  if (item.kind === '削除') return '行を削除';
  const labels = new Map(columns.map((column) => [column.key, column]));
  return Object.keys({...item.before, ...item.after})
    .filter((key) => !key.startsWith('_') && String(item.before?.[key] ?? '') !== String(item.after?.[key] ?? ''))
    .map((key) => {
      const column = labels.get(key) || {key, label: key, kind: 'text'};
      return `${column.label}: ${gridCellText(column, item.before?.[key]) || '（空欄）'} → ${gridCellText(column, item.after?.[key]) || '（空欄）'}`;
    }).join('／');
}

// ── 本体 ────────────────────────────────────────────────────────────────────
function Workbench({data, request, initialDataset = 'works'}) {
  const shell = useShell();
  const role = data?.currentUser?.role || null;
  const previewOnly = Boolean(shell.readOnly);
  const [meta, setMeta] = useState();
  const [dataset, setDataset] = useState(initialDataset);
  const [reloadNonce, setReloadNonce] = useState(0);
  const [loaded, setLoaded] = useState(false);
  const [loadError, setLoadError] = useState(null);
  const [base, setBase] = useState({rows: [], columns: []});
  const [rows, setRows] = useState([]);
  const [savedRows, setSavedRows] = useState([]);
  const [savedSteps, setSavedSteps] = useState('[]');
  const [view, setView] = useState();
  const [steps, setSteps] = useState([]);
  const [draft, setDraft] = useState();
  const [draftChoice, setDraftChoice] = useState('');
  const [drafts, setDrafts] = useState([]);
  const [changeSets, setChangeSets] = useState([]);
  const [recipes, setRecipes] = useState([]);
  const [recipeName, setRecipeName] = useState('');
  const [history, setHistory] = useState([]);
  const [future, setFuture] = useState([]);
  const [filter, setFilter] = useState('');
  const [page, setPage] = useState(0);
  const [selection, setSelection] = useState(null);
  const [focusRequest, setFocusRequest] = useState(0);
  const [lookups, setLookups] = useState({});
  const [lookupNotice, setLookupNotice] = useState(null);
  const [busy, setBusy] = useState('');
  const [notice, setNotice] = useState(null);
  const [gridNotice, setGridNotice] = useState(null);
  const [errors, setErrors] = useState(null);
  const [validation, setValidation] = useState();
  const [changeSet, setChangeSet] = useState();
  const [application, setApplication] = useState();
  const [reason, setReason] = useState('');
  const [file, setFile] = useState();
  const [sheet, setSheet] = useState('');
  const [headerRow, setHeaderRow] = useState(1);
  const [pendingSwitch, setPendingSwitch] = useState(null);
  const [formatSuggestion, setFormatSuggestion] = useState();
  const [formatConfirmed, setFormatConfirmed] = useState(false);
  const [sourceControls, setSourceControls] = useState({});
  const [channelControls, setChannelControls] = useState({});
  const [sourceIdColumns, setSourceIdColumns] = useState({});
  const [salesColumnGroup, setSalesColumnGroup] = useState('shared');
  const seq = useRef(0);
  const pendingOpen = useRef(shell.getParam('draft', null));
  const reasonRef = useRef(null);

  const sets = meta?.datasets?.length ? meta.datasets : FALLBACK;
  const def = sets.find((x) => x.key === dataset) || sets[0];
  const labelOfDataset = (key) => sets.find((x) => x.key === key)?.label || key;
  const scopeOf = (key) => sets.find((x) => x.key === key)?.scope || DATASET_SCOPES[key];
  const access = datasetAccess(dataset, role, scopeOf(dataset));
  const isSales = dataset === 'sales_import';
  const maxRows = def?.maxRows || meta?.notes?.salesImportMaxRows || null;
  const fileBound = Boolean(file?.sourceArtifactId);

  const knownColumn = (column) => ({...column, ...(def?.columns?.find((item) => item.key === column.key) || {}), key: column.key});
  // 内部の ID・版の列は表に出さない（行の識別には使う）
  const allCols = (view?.schema?.map((x) => ({...knownColumn(x), editable: false})) || (base.columns?.length ? base.columns.map(knownColumn) : def?.columns || []))
    .filter((column) => !(HIDDEN_GRID_KEYS.has(column.key) && column.editable === false));
  const canonicalSalesColumns = isSales && !view && allCols.every((column) => def?.columns?.some((item) => item.key === column.key));
  const selectedSalesKeys = new Set(channelSalesGroups[salesColumnGroup] || []);
  const shownCols = canonicalSalesColumns && salesColumnGroup !== 'all' ? allCols.filter((column) => !channelSalesColumns.includes(column.key) || selectedSalesKeys.has(column.key)) : allCols;
  const lookupLists = useMemo(() => ({
    partners: lookups.partners || data?.partners || [],
    products: lookups.products || data?.products || [],
  }), [lookups.partners, lookups.products, data?.partners, data?.products]);
  const readOnly = Boolean(view) || Boolean(draft && draft.status !== 'draft') || access.locked;
  const cols = useMemo(() => gridColumns(shownCols, {dataset, readOnly, lookups: lookupLists, recognitionBases: data?.recognitionBases}),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [JSON.stringify(shownCols), dataset, readOnly, lookupLists, data?.recognitionBases]);
  const allGridCols = useMemo(() => gridColumns(allCols, {dataset, readOnly: true, lookups: lookupLists, recognitionBases: data?.recognitionBases}),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [JSON.stringify(allCols), dataset, lookupLists, data?.recognitionBases]);

  const working = view?.rows || rows;
  const visible = useMemo(() => {
    const needle = filter.trim().toLowerCase();
    if (!needle) return working;
    return working.filter((row) => Object.entries(row).some(([key, value]) => !key.startsWith('_') && show(value).toLowerCase().includes(needle)));
  }, [working, filter]);
  const pageCount = Math.max(1, Math.ceil(visible.length / WB_PAGE_SIZE));
  const pageRows = visible.slice(page * WB_PAGE_SIZE, page * WB_PAGE_SIZE + WB_PAGE_SIZE);
  // 行の識別子は表全体の位置で決める（識別子の無い加工結果の行でも、行番号・エラーの対応がずれない）
  const gridKeys = useMemo(() => {
    const positions = new Map(working.map((row, index) => [row, index]));
    return visible.slice(page * WB_PAGE_SIZE).map((row) => sourceKey(row, positions.get(row)));
  }, [working, visible, page]);
  const pageKeys = gridKeys.slice(0, WB_PAGE_SIZE);
  const numbers = useMemo(() => rowNumbers(working), [working]);
  const diff = useMemo(() => diffRows(base.rows || [], rows), [base.rows, rows]);
  const stepsChanged = JSON.stringify(steps.map(normalize)) !== savedSteps;
  const unsaved = unsavedCount(savedRows, rows, stepsChanged);
  const errorCells = errors?.cells || new Map();
  const rowErrors = errors?.byRow || new Map();
  const issues = useMemo(() => {
    const out = new Map();
    if (view) return out;
    rows.forEach((row, index) => {
      const key = sourceKey(row, index);
      for (const column of cols) {
        const message = cellIssue(column, row[column.key], row);
        if (message) out.set(cellErrorKey(key, column.key), message);
      }
    });
    return out;
  }, [rows, cols, view]);
  const dirty = draft ? Boolean(draft.dirty) : unsaved > 0;
  const flow = workflowState({
    loaded, locked: access.locked, readOnly: previewOnly, hasChanges: unsaved > 0 || steps.length > 0, draft, dirty,
    validation, errorCount: errors?.items?.length || 0, changeSet, application, role, reason,
  });

  // 未保存のセル・手順を外枠の未保存保護に登録する（画面移動・作品切替・タブを閉じる前に確認が出る）
  useEffect(() => {
    shell.registerUnsaved(UNSAVED_ID, unsaved, `${def?.label || '表'}の表編集`);
  }, [unsaved, def?.label]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => () => shell.registerUnsaved(UNSAVED_ID, 0), []); // eslint-disable-line react-hooks/exhaustive-deps

  function resetFlow() {
    setValidation();
    setChangeSet();
    setApplication();
    setView();
  }
  // 表または手順が変わった: 検証・申請をやり直す
  function invalidate() {
    setValidation();
    setView();
    setDraft((d) => (d ? {...d, dirty: true, recipeVersionId: null} : d));
  }
  function applyChange(result, {notice: message} = {}) {
    if (!result?.edits?.length) return;
    setRows(result.rows);
    setHistory((list) => [...list, {edits: result.edits}].slice(-200));
    setFuture([]);
    invalidate();
    // 直したセルの検証エラーは消す（残りは次の検証まで表示する）
    setErrors((current) => {
      if (!current) return current;
      const touched = new Set(result.edits.filter((edit) => edit.type === 'cell').map((edit) => cellErrorKey(edit.key, edit.field)));
      if (!touched.size) return current;
      const items = current.items.filter((item) => !(item.rowKey && item.column && touched.has(cellErrorKey(item.rowKey, item.column))));
      const cells = new Map([...current.cells].filter(([key]) => !touched.has(key)));
      const byRow = new Map();
      for (const item of items) if (item.rowKey) byRow.set(item.rowKey, [...(byRow.get(item.rowKey) || []), item.message]);
      return {items, cells, byRow};
    });
    setGridNotice(message ? {tone: 'info', message} : null);
  }
  const derive = isSales ? deriveSalesValues : undefined;
  function undo() {
    const entry = history.at(-1);
    if (!entry) return;
    setRows((current) => applyEdits(current, entry.edits, 'backward'));
    setHistory((list) => list.slice(0, -1));
    setFuture((list) => [entry, ...list]);
    invalidate();
  }
  function redo() {
    const entry = future[0];
    if (!entry) return;
    setRows((current) => applyEdits(current, entry.edits, 'forward'));
    setFuture((list) => list.slice(1));
    setHistory((list) => [...list, entry]);
    invalidate();
  }

  function clearDatasetState() {
    setFile();
    setSheet('');
    setHeaderRow(1);
    setFormatSuggestion();
    setFormatConfirmed(false);
    setSourceControls({});
    setChannelControls({});
    setSourceIdColumns({});
    setSalesColumnGroup('shared');
    setFilter('');
    setSelection(null);
    setNotice(null);
    setGridNotice(null);
    setErrors(null);
    setReason('');
  }
  function switchDataset(next, {force = false} = {}) {
    if (next === dataset) {
      if (force) setReloadNonce((n) => n + 1);
      return;
    }
    if (!force && unsaved > 0) {
      setPendingSwitch({type: 'dataset', value: next, label: `「${labelOfDataset(next)}」へ切り替える`});
      return;
    }
    setPendingSwitch(null);
    clearDatasetState();
    setDataset(next);
  }
  // 保存していない変更があるときは、下書きを開く前に確かめる（確認ダイアログは使わない）
  function openDraft(draftId) {
    if (!draftId) return;
    if (unsaved > 0) {
      setPendingSwitch({type: 'draft', value: draftId, label: '下書きを開く'});
      return;
    }
    resume(draftId);
  }
  useEffect(() => {
    if (initialDataset !== dataset) switchDataset(initialDataset, {force: true});
  }, [initialDataset]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    setPage(0);
    setSelection(null);
  }, [filter, view]);

  // 読込: メタデータ・表・手順・下書き・変更セット・参照表（取引先・商品）
  useEffect(() => {
    const n = ++seq.current;
    const locked = access.locked;
    setBusy('読込');
    setLoaded(false);
    setLoadError(null);
    const query = `workId=${encodeURIComponent(data?.selectedWorkId || '')}&projectId=${encodeURIComponent(data?.selectedWork?.project_id || '')}`;
    Promise.all([
      request('/workbench/metadata'),
      locked ? null : request(`/workbench/datasets/${dataset}?${query}`),
      locked ? null : request(`/workbench/recipes?dataset=${encodeURIComponent(dataset)}`),
      request('/workbench/drafts'),
      request('/workbench/change-sets'),
    ]).then(async ([m, x, r, dl, cl]) => {
      if (n !== seq.current) return;
      const loadedRows = ensureRowKeys(x?.rows || [], () => `row:${uid()}`);
      setMeta(m);
      setBase({...(x || {}), rows: loadedRows, columns: x?.columns || []});
      setRows(loadedRows);
      setSavedRows(loadedRows);
      setSteps([]);
      setSavedSteps('[]');
      setDraft();
      setDraftChoice('');
      setRecipes(r?.recipes || []);
      setDrafts(dl?.drafts || []);
      setChangeSets(cl?.changeSets || []);
      setHistory([]);
      setFuture([]);
      setErrors(null);
      resetFlow();
      // 読み直した表は原本ファイルとのつながりを持たない（下書きを開くと原本の情報を戻す）
      setFile();
      setSheet('');
      setHeaderRow(1);
      setFormatSuggestion();
      setFormatConfirmed(false);
      setSourceControls({});
      setChannelControls({});
      setSourceIdColumns({});
      const refs = {_snapshots: []};
      let notice = null;
      if (!locked) {
        if (role && role !== 'admin') {
          notice = dataset === 'sales_import'
            ? {tone: 'info', message: '取引先・商品の候補は、登録済みの一覧から表示しています。参照表（固定版）は管理者のみ作れるため、参照表との結合の加工は使えません。'}
            : null;
        } else {
          const failed = [];
          for (const key of ['partners', 'products']) {
            try {
              const found = await request(`/workbench/datasets/${key}`);
              refs[key] = found.rows || [];
              if (found.snapshot?.id) refs._snapshots.push({name: key, snapshotId: found.snapshot.id});
            } catch (error) {
              failed.push({key, error});
            }
          }
          if (failed.length) {
            const names = failed.map((item) => (item.key === 'partners' ? '取引先' : '商品')).join('・');
            const fallback = failed.every((item) => (item.key === 'partners' ? data?.partners : data?.products)?.length);
            notice = {tone: fallback ? 'warn' : 'error', error: failed[0].error,
              message: fallback
                ? `${names}の参照表を取得できませんでした。候補は登録済みの一覧から表示しています（参照表との結合は使えません）。`
                : `${names}の候補を取得できませんでした。再試行してください。`};
          }
        }
      }
      if (n !== seq.current) return;
      setLookups(refs);
      setLookupNotice(notice);
      setLoaded(true);
      const open = pendingOpen.current;
      if (open) {
        pendingOpen.current = null;
        await resume(open, {changeSets: cl?.changeSets || [], currentDataset: dataset, metaColumns: m?.datasets?.find((item) => item.key === dataset)?.columns});
      }
    }).catch((error) => {
      if (n === seq.current) setLoadError(error);
    }).finally(() => {
      if (n === seq.current) setBusy('');
    });
  }, [dataset, data?.selectedWorkId, data?.selectedWork?.project_id, reloadNonce, access.locked]); // eslint-disable-line react-hooks/exhaustive-deps

  const runBusy = async (label, task) => {
    setBusy(label);
    try {
      return await task();
    } finally {
      setBusy('');
    }
  };
  // サーバーの理由（日本語）はそのまま、画面の中で起きた想定外の例外は日本語の1文にして、技術情報は折りたたみへ。
  const failure = (error, fallback) => setNotice({tone: 'error', error, message: isApiError(error) ? undefined : fallback});

  async function save() {
    if (previewOnly) return;
    if (isSales && !data?.selectedWorkId) {
      setNotice({tone: 'error', message: '売上の下書きは作品ごとに作ります。画面上部で作品を選んでください。'});
      return;
    }
    if (maxRows && rows.length > maxRows) {
      setNotice({tone: 'error', message: `1回に保存できるのは${formatInt(maxRows)}行までです（${meta?.notes?.salesImportLimitReason || '上限'}）。報告を分けて取り込んでください。`});
      return;
    }
    await runBusy('保存', async () => {
      try {
        let d = draft;
        const lookupSnapshots = lookups._snapshots || [];
        const normalizedSteps = steps.map(normalize);
        const recipeVersionId = d?.recipeVersionId || recipes.find((r) => JSON.stringify(r.latestVersion.steps) === JSON.stringify(normalizedSteps)
          && JSON.stringify(r.latestVersion.lookupSnapshots || []) === JSON.stringify(lookupSnapshots))?.latestVersion.id || null;
        if (!d || d.status !== 'draft') {
          const sourceArtifact = file?.sourceArtifactId ? {sourceArtifactId: file.sourceArtifactId, sheetName: sheet, headerRow: Number(headerRow)} : {};
          const out = await request('/workbench/drafts', {method: 'POST', body: JSON.stringify({dataset, workId: data?.selectedWorkId, projectId: data?.selectedWork?.project_id, rows, steps: normalizedSteps, ...(file?.sourceArtifactId ? sourceArtifact : {sourceSnapshotId: base.snapshot?.id}), lookupSnapshots, recipeVersionId})});
          d = out.draft;
        } else {
          const out = await request(`/workbench/drafts/${encodeURIComponent(d.id)}`, {method: 'PUT', headers: {'If-Match': String(d.revision)}, body: JSON.stringify({rows, steps: normalizedSteps, lookupSnapshots, recipeVersionId})});
          d = {...d, ...out.draft};
        }
        const savedAt = new Date().toISOString();
        setDraft({...d, dirty: false});
        setSavedRows(rows);
        setSavedSteps(JSON.stringify(normalizedSteps));
        setValidation();
        setChangeSet();
        setApplication();
        setDrafts((list) => [{...d, dataset, rowCount: rows.length, updatedAt: savedAt}, ...list.filter((item) => item.id !== d.id)]);
        setDraftChoice(d.id);
        shell.setParam('draft', d.id, {replace: true});
        setNotice({tone: 'ok', message: `下書きを保存しました（第${d.revision}版・${formatInt(rows.length)}行）。次は「全件を検証する」です。`});
      } catch (error) {
        failure(error, '下書きを保存できませんでした');
      }
    });
  }

  async function resume(draftId, {changeSets: knownChangeSets = changeSets, currentDataset = dataset, metaColumns} = {}) {
    if (!draftId) return;
    await runBusy('再開', async () => {
      try {
        const x = await request(`/workbench/drafts/${encodeURIComponent(draftId)}`);
        const d = x.draft;
        if (d.dataset !== currentDataset) {
          pendingOpen.current = d.id;
          switchDataset(d.dataset, {force: true});
          return;
        }
        const cs = knownChangeSets.find((c) => c.draftId === d.id && ['submitted', 'approved', 'applied'].includes(c.status));
        const savedValidation = cs ? (await request(`/workbench/change-sets/${encodeURIComponent(cs.id)}/validation`)).validation : undefined;
        if (cs && (!savedValidation || savedValidation.draftId !== d.id || savedValidation.revision !== d.revision)) {
          setNotice({tone: 'error', message: '申請した検証結果と下書きの版が一致しないため開けません。新しい下書きで直してください。'});
          return;
        }
        const restored = ensureRowKeys(clone(d.rows), () => `row:${uid()}`);
        setRows(restored);
        setSavedRows(restored);
        if (d.dataset === 'sales_import') {
          const headers = Object.keys(d.rows[0] || {}).filter((k) => k !== '_source' && k !== '_lineage');
          const savedInputs = restoredSalesInputs(savedValidation);
          // 保存した行の列は名前順に並ぶため、共通の列だけのときはメタデータの順（報告キー→…→税込額）で並べ直す
          const canonical = metaColumns || def?.columns || [];
          const known = new Set(canonical.map((c) => c.key));
          const ordered = headers.every((key) => known.has(key)) ? canonical
            : [...canonical.filter((c) => headers.includes(c.key)), ...headers.filter((key) => !known.has(key)).map((key) => ({key, label: key, editable: true}))];
          setBase({rows: restored, columns: ordered, snapshot: {id: d.sourceSnapshotId}});
          setFormatSuggestion(suggestSalesImportFormats({headers, rows: d.rows}));
          setFormatConfirmed(savedInputs.formatConfirmed);
          setSourceControls(savedInputs.sourceTotals);
          setChannelControls(savedInputs.channelTotals);
          setSourceIdColumns(savedInputs.sourceIdentifierColumns);
          setFile(d.sourceArtifactId ? {sourceArtifactId: d.sourceArtifactId, sourceHash: d.rows[0]?._source?.sourceHash} : undefined);
          setSheet(d.sourceScope?.sheetName || d.rows[0]?._source?.sheet || '');
          setHeaderRow(d.sourceScope?.headerRow || 1);
        }
        const restoredSteps = (d.steps || []).map(editableStep);
        setSteps(restoredSteps);
        setSavedSteps(JSON.stringify(restoredSteps.map(normalize)));
        setLookups((l) => ({...l, _snapshots: d.lookupSnapshots || []}));
        setHistory([]);
        setFuture([]);
        setView();
        setDraft({...d, dirty: false});
        setDraftChoice(d.id);
        setChangeSet(cs);
        setValidation(savedValidation);
        setApplication(cs?.status === 'applied' ? {appliedAt: cs.appliedAt} : undefined);
        setErrors(null);
        setReason(cs?.reason || '');
        shell.setParam('draft', d.id, {replace: true});
        setNotice({tone: 'info', message: cs ? `下書き（第${d.revision}版）を開きました。状態: ${statusText(cs.status)}` : `下書き（第${d.revision}版）を開きました`});
      } catch (error) {
        failure(error, '下書きを開けませんでした');
      }
    });
  }

  async function preview(count = steps.length) {
    if (previewOnly) return;
    await runBusy('確認', async () => {
      try {
        const out = await request('/workbench/transforms/preview', {method: 'POST', body: JSON.stringify({rows, steps: steps.slice(0, count).map(normalize), lookupSnapshots: lookups._snapshots || [], limit: 500})});
        setView({...out, stepCount: count});
        setNotice({tone: 'info', message: `加工手順${count}までの結果です（全${formatInt(out.totalRows)}行中${formatInt(out.previewRows)}行を表示）。「元の表へ戻る」で編集に戻ります。`});
      } catch (error) {
        failure(error, '加工の結果を確かめられませんでした');
      }
    });
  }

  async function validate() {
    if (!draft || previewOnly) return;
    if (draft.dirty) {
      setNotice({tone: 'warn', message: '保存していない変更があります。下書きを保存してから検証してください。'});
      return;
    }
    await runBusy('検証', async () => {
      try {
        const x = await request(`/workbench/drafts/${encodeURIComponent(draft.id)}/validate`, {
          method: 'POST', strict: true,
          body: JSON.stringify({revision: draft.revision, lookupSnapshots: lookups._snapshots || [], formatConfirmed, sourceTotals: entered(sourceControls), channelTotals: entered(channelControls), sourceIdentifierColumns: entered(sourceIdColumns)}),
        });
        const v = x.validation;
        setValidation(v);
        setErrors(null);
        const warnings = (v.warnings || []).map((w) => (typeof w === 'string' ? w : w?.message)).filter(Boolean);
        const changeCount = Array.isArray(v.changes) ? v.changes.length : null;
        const done = `全${formatInt(v.rowCount)}行を検証しました。エラーはありません${changeCount !== null ? `（反映する変更 ${formatInt(changeCount)}件）` : ''}。`;
        setNotice({
          tone: warnings.length ? 'warn' : 'ok',
          title: warnings.length ? `原本との照合で未確認の項目が${formatInt(warnings.length)}件あります` : undefined,
          message: warnings.length
            ? `${done}原本に記載の件数・合計を入れていない項目は「未確認」のまま申請できます。入れる場合は上の「原本に明記された件数・合計を照合する」に入力して検証し直してください。`
            : `${done}変更理由を書いて承認を申請してください。`,
          details: warnings.length ? warnings : undefined,
        });
      } catch (error) {
        const details = isApiError(error) ? error.details : null;
        const rowDetails = Array.isArray(details) && details.some((d) => d && typeof d === 'object' && ('rowNo' in d || 'inputRow' in d));
        if (rowDetails) {
          const mapped = mapRowErrors(details, {rows, columns: allGridCols, hasSteps: steps.length > 0});
          setErrors(mapped);
          setValidation();
          setNotice({tone: 'error', title: `${formatInt(mapped.items.length)}件のエラーがあります`, message: '赤いセル（行番号に「!」）を直して下書きを保存し、もう一度検証してください。一覧の「セルへ移る」で該当のセルを開けます。'});
        } else {
          setErrors(null);
          // 原本照合の失敗（409）などは理由の文だけを並べる（照合項目のコード名は主表示に出さない）
          const messages = Array.isArray(details) ? details.map((item) => (typeof item === 'string' ? item : item?.message)).filter(Boolean) : [];
          setNotice({tone: 'error', error, details: messages.length ? messages : []});
        }
      }
    });
  }

  async function submit() {
    if (!draft || !validation || previewOnly) return;
    if (!reason.trim()) {
      setNotice({tone: 'warn', message: '変更理由を入力してください。'});
      reasonRef.current?.focus();
      return;
    }
    await runBusy('申請', async () => {
      try {
        const x = await request(`/workbench/drafts/${encodeURIComponent(draft.id)}/submit`, {method: 'POST', body: JSON.stringify({revision: draft.revision, validationId: validation.id, reason})});
        const cs = {...x.changeSet, draftId: draft.id, dataset, reason, createdAt: new Date().toISOString()};
        setChangeSet(cs);
        setChangeSets((list) => [cs, ...list.filter((item) => item.id !== cs.id)]);
        setDraft((d) => ({...d, status: 'submitted'}));
        setNotice({tone: 'ok', message: role === 'admin' ? '承認を申請しました。内容を確かめて「承認する」を押してください。' : '承認を申請しました。管理者が承認すると反映できます。待つ間も「新しい下書きで続けて編集」で作業を続けられます。'});
      } catch (error) {
        failure(error, '承認を申請できませんでした');
      }
    });
  }

  async function approve() {
    if (!changeSet || previewOnly) return;
    await runBusy('承認', async () => {
      try {
        const x = await request(`/workbench/change-sets/${encodeURIComponent(changeSet.id)}/approve`, {method: 'POST', body: JSON.stringify({revision: changeSet.revision, hash: changeSet.hash})});
        const next = {...changeSet, ...x.changeSet};
        setChangeSet(next);
        setChangeSets((list) => list.map((item) => (item.id === next.id ? {...item, ...next} : item)));
        setNotice({tone: 'ok', message: '承認しました。「DBへ反映する」で業務データへ反映します。'});
      } catch (error) {
        failure(error, '承認できませんでした');
      }
    });
  }

  async function apply() {
    if (!changeSet || previewOnly) return;
    let key = applyKeys.get(changeSet.id);
    if (!key) {
      key = `apply:${changeSet.id}:${uid()}`;
      applyKeys.set(changeSet.id, key);
    }
    await runBusy('反映', async () => {
      let result = null;
      try {
        const x = await request(`/workbench/change-sets/${encodeURIComponent(changeSet.id)}/apply`, {method: 'POST', body: JSON.stringify({revision: changeSet.revision, hash: changeSet.hash, idempotencyKey: key})});
        result = {application: x.application, replayed: x.replayed};
      } catch (error) {
        try {
          const x = await request(`/workbench/applications/${encodeURIComponent(key)}`);
          result = {application: x.application, recovered: true};
        } catch {
          failure(error, '反映できませんでした');
          return;
        }
      }
      const count = result.application?.appliedRows ?? 0;
      setApplication(result.application);
      setChangeSet((c) => ({...c, status: 'applied'}));
      setChangeSets((list) => list.map((item) => (item.id === changeSet.id ? {...item, status: 'applied'} : item)));
      const message = `${formatInt(count)}行を業務データへ反映しました${result.recovered ? '（途切れた応答から結果を取り直しました）' : result.replayed ? '（反映済みの結果）' : ''}。`;
      pendingOpen.current = null;
      shell.setParam('draft', null, {replace: true});
      setReloadNonce((n) => n + 1);
      setNotice({
        tone: 'ok',
        message: isSales ? `${message}売上の一覧で確かめられます。表は空にしたので、次の報告を続けて取り込めます。` : `${message}最新の表を読み直しました。続けて編集できます。`,
        actions: isSales && role !== 'production' ? <button type="button" className="secondary" onClick={() => shell.navigate('売上')}>売上の一覧を開く</button> : null,
      });
    });
  }

  // 申請・反映の後も、新しい下書きで続けて編集する
  function restart() {
    const applied = Boolean(application) || changeSet?.status === 'applied';
    shell.setParam('draft', null, {replace: true});
    setDraft();
    setDraftChoice('');
    resetFlow();
    setErrors(null);
    setReason('');
    if (applied || !isSales) {
      setReloadNonce((n) => n + 1);
      setNotice({tone: 'info', message: isSales ? '新しい下書きを始めました。' : '最新の表を読み直しました。申請中の変更は、反映されると表に現れます。'});
      return;
    }
    // 売上取込（申請中）: 今の表を写して新しい下書きにする
    setSavedRows([]);
    setSavedSteps('[]');
    setNotice({tone: 'info', message: '今の表を写して新しい下書きを始めました。直してから「下書きを保存する」を押してください。'});
  }

  async function saveRecipe() {
    if (!recipeName.trim() || previewOnly) return;
    await runBusy('手順保存', async () => {
      try {
        const existing = recipes.find((x2) => x2.name === recipeName.trim());
        const payload = {steps: steps.map(normalize), lookupSnapshots: lookups._snapshots || []};
        const x = existing
          ? await request(`/workbench/recipes/${encodeURIComponent(existing.id)}/versions`, {method: 'POST', body: JSON.stringify(payload)})
          : await request('/workbench/recipes', {method: 'POST', body: JSON.stringify({dataset, name: recipeName.trim(), ...payload})});
        setDraft((d) => (d ? {...d, recipeVersionId: x.version.id, dirty: true} : d));
        const r = await request(`/workbench/recipes?dataset=${encodeURIComponent(dataset)}`);
        setRecipes(r.recipes || []);
        setNotice({tone: 'ok', message: existing ? `加工手順「${recipeName.trim()}」の第${x.version.versionNo}版を保存しました` : `加工手順「${recipeName.trim()}」を保存しました`});
      } catch (error) {
        failure(error, '加工手順を保存できませんでした');
      }
    });
  }

  async function importFile(input) {
    const f = input.files?.[0];
    if (!f || previewOnly) return;
    setFormatSuggestion();
    setFormatConfirmed(false);
    setSourceControls({});
    setChannelControls({});
    setSourceIdColumns({});
    if (f.size > 5 * 1024 * 1024) {
      setNotice({tone: 'error', message: '原本ファイルは5MB以内にしてください。'});
      return;
    }
    await runBusy('抽出', async () => {
      try {
        const base64 = await new Promise((ok, no) => {
          const reader = new FileReader();
          reader.onload = () => ok(String(reader.result).split(',')[1]);
          reader.onerror = no;
          reader.readAsDataURL(f);
        });
        const x = await request('/workbench/files/extract', {method: 'POST', body: JSON.stringify({name: f.name, base64, workId: data?.selectedWorkId})});
        setFile({...x.file, sourceArtifactId: x.sourceArtifactId, sheets: x.sheets, warnings: x.warnings || []});
        setSheet(x.sheets[0]?.name || '');
        setNotice({tone: 'info', message: `${formatInt(x.sheets.length)}シートを読み取りました。見出し行を確かめて「選んだシートを表へ取り込む」を押してください。`});
      } catch (error) {
        failure(error, '原本ファイルを読み取れませんでした');
      }
    });
  }

  function takeSheet() {
    const s = file?.sheets?.find((x) => x.name === sheet);
    if (!s) return;
    if (s.formulaIssues?.length) {
      setNotice({tone: 'error', message: `数式のセル（${s.formulaIssues.map((x) => x.cell).join('、')}）に計算結果がありません。Excelで再計算して保存し直してください。`});
      return;
    }
    try {
      const next = rowsFromSheet(s, headerRow, file.sourceHash);
      if (maxRows && next.length > maxRows) {
        setNotice({tone: 'error', message: `このシートは${formatInt(next.length)}行あります。1回に取り込めるのは${formatInt(maxRows)}行までです（${meta?.notes?.salesImportLimitReason || '上限'}）。`});
        return;
      }
      const headers = Object.keys(next[0] || {}).filter((key) => key !== '_source' && key !== '_lineage');
      setFormatSuggestion(suggestSalesImportFormats({headers, rows: next}));
      setFormatConfirmed(false);
      setSourceControls({});
      setChannelControls({});
      setSourceIdColumns({});
      setBase({rows: clone(next), columns: headers.map((key) => ({key, label: key, editable: true})), snapshot: null});
      setRows(next);
      setSavedRows([]);
      setHistory([]);
      setFuture([]);
      setErrors(null);
      setDraft();
      setDraftChoice('');
      resetFlow();
      shell.setParam('draft', null, {replace: true});
      setNotice({tone: 'ok', message: `${formatInt(next.length)}行を表へ取り込みました（原本の情報は下書きに残します）。列名を共通の項目へそろえるには、左の「加工を足す」を使います。`});
    } catch (error) {
      setNotice({tone: 'error', message: error.message});
    }
  }

  function filterImportKind(kind) {
    const next = step('filter');
    next.parameters = {column: 'kind', operator: 'eq', value: kind, valueType: 'string'};
    setSteps((current) => [...current.filter((s) => !(s.operation === 'filter' && s.parameters.column === 'kind')), next]);
    invalidate();
    setNotice({tone: 'info', message: `${KIND_LABELS[kind]}の行に絞る加工手順を足しました。「最終結果を見る」で確かめ、下書きを保存してください。原本の全行は残します。`});
  }

  // ── 表の操作 ──
  const appendBlock = !isSales
    ? `${def?.label || 'マスタ'}の行の追加はExcel一括登録で行ってください（取引先・作品・商品マスタの画面の「Excelで一括登録」）。`
    : fileBound ? '原本から読み込んだ表は行を増やせません。行の除外は加工手順の「行を絞り込み」で行います。'
      : filter ? '絞り込み中は行を足せません。絞込を解除してから貼り付けてください。' : null;
  const canAddRows = isSales && !fileBound && !view && !readOnly;
  const makeRow = (index, previous) => newSalesRow(previous, `new:${uid()}`);
  function gridAction(action) {
    const rect = rectangle(selection?.anchor, selection?.focus);
    switch (action.type) {
      case 'undo': undo(); return;
      case 'redo': redo(); return;
      case 'clear': {
        const result = clearCells(rows, gridKeys, cols, rect, {derive});
        applyChange(result, {notice: result.skipped && !result.edits.length ? '読み取り専用・計算の列は消せません' : null});
        return;
      }
      case 'fillDown': applyChange(fillDown(rows, gridKeys, cols, rect, {derive})); return;
      case 'pasteText': {
        const result = pasteCells(rows, gridKeys, cols, selection || {anchor: {r: 0, c: 0}, focus: {r: 0, c: 0}}, action.text, {
          allowAppend: canAddRows && !filter, makeRow, derive, appendHint: appendBlock || undefined,
        });
        if (!result.ok) {
          setGridNotice({tone: 'warn', message: result.message});
          return;
        }
        const parts = [];
        if (result.appended) parts.push(`${formatInt(result.appended)}行を足しました`);
        if (result.skipped) parts.push(`読み取り専用・計算の列の${formatInt(result.skipped)}セルは貼り付けませんでした`);
        if (!result.edits.length) {
          setGridNotice({tone: 'info', message: result.skipped ? '読み取り専用・計算の列には貼り付けられません' : '貼り付けた値は今の値と同じでした'});
          return;
        }
        applyChange(result, {notice: parts.length ? `貼り付けました。${parts.join('。')}。` : null});
        return;
      }
      case 'readonly':
        setGridNotice({tone: 'info', message: access.locked ? access.reason
          : view ? '加工結果の表示中は編集できません。「元の表へ戻る」で編集に戻ります'
            : draft && draft.status !== 'draft' ? '申請済みの下書きは編集できません。「新しい下書きで続けて編集」で続けられます'
              : action.column?.derived ? `${action.column.label}は${SALES_DERIVED[action.column.key]}（直接は入力しません）`
                : `${action.column?.label || 'この列'}は読み取り専用です`});
        return;
      default:
    }
  }
  function commitCell(key, field, value) {
    applyChange(setCells(rows, [{key, field, value}], {derive}));
  }
  function addRow() {
    const result = insertRow(rows, makeRow(0, rows.at(-1) || null));
    applyChange(result, {notice: '行を足しました。直前の行の報告キー・取引先・期間・計上基準を写しています。'});
    const position = visible.length; // 絞込なし（行の追加は絞込中は出さない）
    setPage(Math.floor(position / WB_PAGE_SIZE));
    setSelection({anchor: {r: position % WB_PAGE_SIZE, c: 0}, focus: {r: position % WB_PAGE_SIZE, c: 0}});
    setFocusRequest((n) => n + 1);
  }
  function deleteSelectedRows() {
    const keys = selectedRowKeys(pageKeys, selection);
    if (!keys.length) return;
    applyChange(deleteRowsByKeys(rows, keys), {notice: `${formatInt(keys.length)}行を消しました（Ctrl+Z で戻せます）`});
    setSelection(null);
  }
  function recomputeDerived() {
    const changes = [];
    rows.forEach((row, index) => {
      const next = deriveSalesValues(row);
      for (const field of Object.keys(SALES_DERIVED)) {
        if (Object.hasOwn(row, field) && String(row[field] ?? '') !== String(next[field] ?? '')) changes.push({key: sourceKey(row, index), field, value: next[field]});
      }
    });
    const result = setCells(rows, changes);
    if (result.edits.length) applyChange(result, {notice: `${formatInt(result.edits.length)}セルの税込額・計上月を計算し直しました`});
    else setGridNotice({tone: 'info', message: '計算し直す必要のあるセルはありません'});
  }
  function jumpTo(rowKey, column) {
    let position = visible.findIndex((row, index) => sourceKey(row, index) === rowKey);
    if (position < 0) {
      setFilter('');
      position = working.findIndex((row, index) => sourceKey(row, index) === rowKey);
    }
    if (position < 0) return;
    if (column && !cols.some((c) => c.key === column) && allCols.some((c) => c.key === column)) setSalesColumnGroup('all');
    const c = Math.max(0, (column && !cols.some((col) => col.key === column) ? allCols : cols).findIndex((col) => col.key === column));
    setTimeout(() => {
      setPage(Math.floor(position / WB_PAGE_SIZE));
      setSelection({anchor: {r: position % WB_PAGE_SIZE, c}, focus: {r: position % WB_PAGE_SIZE, c}});
      setFocusRequest((n) => n + 1);
    }, 0);
  }
  function exportTable(format) {
    try {
      const sheetSpec = workbenchSheet({
        title: `${def?.label || '表'}の表編集`, columns: cols, rows: visible, allRows: working, errors,
        conditions: [['データ', def?.label || ''], ...(filter ? [['絞込', filter]] : []), ...(view ? [['表示', `加工手順${view.stepCount}までの結果`]] : [])],
        dataAsOf: new Date().toISOString(),
      });
      const name = reportBaseName(`表編集_${def?.label || '表'}`, '');
      if (format === 'xlsx') downloadReportXlsx(`${name}.xlsx`, {sheets: [sheetSpec]});
      else {
        const table = specTable(sheetSpec, {mode: 'raw'});
        downloadDocument(`${name}.csv`, csvDocument([table.header, ...table.rows]), 'text/csv;charset=utf-8');
      }
    } catch (error) {
      setNotice({tone: 'error', message: '出力できませんでした。表示を絞るなどして行・列を減らし、もう一度出力してください。', technical: String(error?.message || error)});
    }
  }

  function runNext(action) {
    if (action === 'save') save();
    else if (action === 'validate') validate();
    else if (action === 'submit') submit();
    else if (action === 'approve') approve();
    else if (action === 'apply') apply();
    else if (action === 'restart') restart();
  }

  const datasetDrafts = drafts.filter((d) => d.dataset === dataset);
  const changeSetOf = (draftId) => changeSets.find((c) => c.draftId === draftId) || null;
  const waiting = changeSets.filter((c) => c.status === 'submitted' || c.status === 'approved');
  const importKinds = isSales ? [...new Set(rows.map((row) => row.kind).filter(Boolean))] : [];
  const selectedKeys = selectedRowKeys(pageKeys, selection);
  const errorCount = errors?.items?.length || 0;
  const title = isSales ? '売上の表' : `${def?.label || 'マスタ'}の表`;

  return (
    <div className="workbench">
      <header className="wb-head">
        <div>
          <h2>{title}</h2>
          <p className="wb-sub">
            {isSales
              ? <>作品: {data?.selectedWork?.title || '未選択'}{maxRows ? `・1回に${formatInt(maxRows)}行まで（${meta?.notes?.salesImportLimitReason || '上限'}）` : ''}</>
              : <>表で直した内容は、全件の検証と管理者の承認を経て業務データへ反映します。</>}
          </p>
        </div>
      </header>
      {!access.locked && <StageBar flow={flow} busy={busy} onNext={runNext} />}
      <div className="wb-notices" aria-live="polite">
        {previewOnly && <Notice tone="info" compact message="プレビューでは保存・検証・申請・反映はできません（表の操作は試せます）。" />}
        {loadError && <Notice error={loadError} onRetry={() => setReloadNonce((n) => n + 1)} />}
        {notice && <Notice {...notice} onDismiss={() => setNotice(null)} />}
        {lookupNotice && isSales && <Notice {...lookupNotice} compact onRetry={lookupNotice.tone === 'error' || lookupNotice.tone === 'warn' ? () => setReloadNonce((n) => n + 1) : undefined} onDismiss={() => setLookupNotice(null)} />}
      </div>
      {isSales && !access.locked && (
        <ImportPreflight suggestion={formatSuggestion} confirmed={formatConfirmed} setConfirmed={(v) => { setFormatConfirmed(v); setValidation(); }}
          controls={sourceControls} setControls={(v) => { setSourceControls(v); setValidation(); }}
          channelControls={channelControls} setChannelControls={(v) => { setChannelControls(v); setValidation(); }}
          idColumns={sourceIdColumns} setIdColumns={(v) => { setSourceIdColumns(v); setValidation(); }}
          validation={validation} locked={Boolean(draft && draft.status !== 'draft') || Boolean(changeSet)} />
      )}
      {importKinds.length > 1 && (
        <section className="wb-import-preflight" aria-label="取り込む販路の選択">
          <h3>取り込む販路を選ぶ</h3>
          <p>この原本には複数の販路があります。販路ごとに検証・承認します。原本全体の合計と、選んだ販路の合計をそれぞれ照合できます。</p>
          <div className="wb-inline-actions">
            {importKinds.filter((kind) => KIND_LABELS[kind]).map((kind) => (
              <button key={kind} type="button" className="secondary" disabled={Boolean(busy) || readOnly} onClick={() => filterImportKind(kind)}>{KIND_LABELS[kind]}の行に絞る</button>
            ))}
          </div>
        </section>
      )}
      <div className={`wb-layout${!access.locked && steps.length > 0 ? ' has-steps' : ''}`}>
        <aside className="wb-left" aria-label="データと下書き">
          <h3>データ</h3>
          <div className="wb-datasets">
            {sets.map((d) => {
              const lock = datasetAccess(d.key, role, scopeOf(d.key));
              return (
                <button type="button" className={dataset === d.key ? 'selected' : ''} aria-current={dataset === d.key ? 'true' : undefined} key={d.key} onClick={() => switchDataset(d.key)}>
                  <span>{d.label}</span>{lock.locked && <small className="wb-lock">施錠: {lock.reason}</small>}
                </button>
              );
            })}
          </div>
          {pendingSwitch && (
            <Notice tone="warn" compact title="保存していない変更があります" message={`${pendingSwitch.label}と、この表の保存していない変更（${formatInt(unsaved)}件）は失われます。`}
              actions={<>
                <button type="button" onClick={() => {
                  const target = pendingSwitch;
                  setPendingSwitch(null);
                  if (target.type === 'dataset') switchDataset(target.value, {force: true});
                  else resume(target.value);
                }}>変更を破棄して進む</button>
                <button type="button" className="secondary" onClick={() => setPendingSwitch(null)}>戻って保存する</button>
              </>} />
          )}
          {!access.locked && (
            <>
              <h3>保存した下書き</h3>
              {datasetDrafts.length
                ? <>
                  <select aria-label="保存した下書き" value={draftChoice} onChange={(event) => setDraftChoice(event.target.value)}>
                    <option value="">下書きを選ぶ</option>
                    {datasetDrafts.map((d) => <option key={d.id} value={d.id}>{draftLabel(d, {datasetLabel: labelOfDataset(d.dataset), changeSet: changeSetOf(d.id)})}</option>)}
                  </select>
                  <button type="button" className="secondary" disabled={!draftChoice || Boolean(busy)} onClick={() => openDraft(draftChoice)}>選んだ下書きを開く</button>
                </>
                : <p className="wb-muted">このデータの下書きはまだありません。</p>}
            </>
          )}
          {waiting.length > 0 && (
            <>
              <h3>{role === 'admin' ? '承認・反映の待ち' : '申請中の変更'}</h3>
              <ul className="wb-waiting">
                {waiting.map((cs) => (
                  <li key={cs.id}>
                    <span>{labelOfDataset(cs.dataset)}・「{cs.reason}」</span>
                    <small>{statusText(cs.status)}・{dateTimeJst(cs.createdAt)}</small>
                    <button type="button" className="secondary wb-small" disabled={Boolean(busy)} onClick={() => openDraft(cs.draftId)}>開いて確かめる</button>
                  </li>
                ))}
              </ul>
            </>
          )}
          {isSales && !access.locked && (
            <>
              <h3>原本（Excel・CSV）から読む</h3>
              <input type="file" accept=".csv,.xlsx" aria-label="原本ファイル" disabled={previewOnly || Boolean(busy)} onChange={(event) => importFile(event.target)} />
              {file?.sheets
                ? <>
                  <label>シート<select value={sheet} onChange={(event) => setSheet(event.target.value)}>{file.sheets.map((s) => <option key={s.name}>{s.name}</option>)}</select></label>
                  <label>見出しの行<input type="number" min="1" value={headerRow} onChange={(event) => setHeaderRow(event.target.value)} /></label>
                  <button type="button" onClick={takeSheet}>選んだシートを表へ取り込む</button>
                  {file.warnings.map((w, i) => <small className="wb-bad" key={i}>{show(w)}</small>)}
                </>
                : fileBound && <small className="wb-muted">保存済みの原本につながっています{sheet ? `（シート「${sheet}」）` : ''}</small>}
            </>
          )}
          {!access.locked && (
            <details className="wb-ops" open={steps.length > 0}>
              <summary>加工を足す（列名の変更・絞込など）</summary>
              {recipes.length > 0 && (
                <select aria-label="保存した加工手順" value="" disabled={Boolean(draft && draft.status !== 'draft')} onChange={(event) => {
                  const r = recipes.find((x) => x.id === event.target.value);
                  if (r) {
                    setSteps(r.latestVersion.steps.map(editableStep));
                    invalidate();
                    setLookups((l) => ({...l, _snapshots: r.latestVersion.lookupSnapshots || []}));
                    setDraft((d) => (d ? {...d, recipeVersionId: r.latestVersion.id, dirty: true} : d));
                  }
                }}>
                  <option value="">保存した加工手順を使う</option>
                  {recipes.map((r) => <option key={r.id} value={r.id}>{r.name}（第{r.latestVersion.versionNo}版）</option>)}
                </select>
              )}
              {Object.entries(OPS).map(([k, v]) => (
                <button type="button" key={k} disabled={Boolean(draft && draft.status !== 'draft')} onClick={() => { setSteps((x) => [...x, step(k)]); invalidate(); }}>＋ {v}</button>
              ))}
            </details>
          )}
        </aside>

        <section className="wb-center" aria-label="表">
          {access.locked
            ? (
              <div className="wb-locked" role="status">
                <strong>施錠: {def?.label}の表は開けません</strong>
                <p>{access.reason}。{role === 'production' ? '制作担当の役割では、表編集を使えません。' : '変更が必要なときは管理者に依頼してください。'}</p>
                {role !== 'production' && VIEW_PAGES[dataset] && <button type="button" className="secondary" onClick={() => shell.navigate(VIEW_PAGES[dataset])}>「{VIEW_PAGES[dataset]}」で見る</button>}
              </div>
            )
            : (
              <>
                <div className="wb-toolbar" role="toolbar" aria-label="表の操作">
                  <label>表示を絞る<input type="search" value={filter} onChange={(event) => setFilter(event.target.value)} placeholder="値で検索" /></label>
                  <span className="wb-count">{visible.length === working.length ? `${formatInt(working.length)}行` : `${formatInt(working.length)}行中${formatInt(visible.length)}行`}</span>
                  {pageCount > 1 && (
                    <span className="wb-pager">
                      <button type="button" className="secondary wb-small" disabled={!page} onClick={() => { setPage((x) => x - 1); setSelection(null); }}>前の{WB_PAGE_SIZE}行</button>
                      <span>{page + 1}／{pageCount}ページ</span>
                      <button type="button" className="secondary wb-small" disabled={page + 1 >= pageCount} onClick={() => { setPage((x) => x + 1); setSelection(null); }}>次の{WB_PAGE_SIZE}行</button>
                    </span>
                  )}
                  <span className="wb-tool-group">
                    <button type="button" className="secondary wb-small" disabled={!history.length || Boolean(view) || Boolean(busy)} onClick={undo}>元に戻す</button>
                    <button type="button" className="secondary wb-small" disabled={!future.length || Boolean(view) || Boolean(busy)} onClick={redo}>やり直す</button>
                  </span>
                  {isSales && !view && canonicalSalesColumns && (
                    <span className="wb-tool-group">
                      <button type="button" className="secondary wb-small" disabled={!canAddRows || Boolean(filter)} title={appendBlock || undefined} onClick={addRow}>行を足す</button>
                      <button type="button" className="secondary wb-small" disabled={!canAddRows || !selectedKeys.length} onClick={deleteSelectedRows}>選択した{selectedKeys.length > 1 ? `${formatInt(selectedKeys.length)}行` : '行'}を消す</button>
                      <button type="button" className="secondary wb-small" disabled={readOnly || !rows.length} onClick={recomputeDerived}>税込額・計上月を計算し直す</button>
                    </span>
                  )}
                  <span className="wb-tool-group">
                    <button type="button" className="secondary wb-small" disabled={!visible.length} onClick={() => exportTable('xlsx')}>Excelで出力</button>
                    <button type="button" className="secondary wb-small" disabled={!visible.length} onClick={() => exportTable('csv')}>CSVで出力</button>
                  </span>
                  {view && <button type="button" className="wb-small" onClick={() => setView()}>元の表へ戻る</button>}
                </div>
                {canonicalSalesColumns && (
                  <label className="wb-column-picker">表示する列
                    <select value={salesColumnGroup} onChange={(event) => setSalesColumnGroup(event.target.value)}>
                      <option value="shared">共通項目</option><option value="theatrical">劇場の売上</option><option value="package">ビデオグラムの売上・在庫</option><option value="digital">配信の売上</option><option value="all">すべて</option>
                    </select>
                  </label>
                )}
                <p className="wb-hint">{view ? `加工手順${view.stepCount}までの結果（読み取り専用）です。` : readOnly ? '申請済みのため読み取り専用です。' : GRID_HINT}</p>
                {gridNotice && <Notice {...gridNotice} compact onDismiss={() => setGridNotice(null)} />}
                {working.length
                  ? <Grid rows={pageRows} keys={pageKeys} numbers={numbers} columns={cols} selection={selection} setSelection={setSelection} readOnly={readOnly}
                    errorCells={errorCells} issues={issues} rowErrors={rowErrors} onCommit={commitCell} onAction={gridAction} focusRequest={focusRequest}
                    label={`${def?.label || '表'}（${formatInt(working.length)}行）`} />
                  : (
                    <div className="wb-empty" tabIndex={canAddRows ? 0 : undefined} aria-label={canAddRows ? '空の表（ここで Ctrl+V を押すと Excel の範囲を行として貼り付けます）' : undefined}
                      onPaste={canAddRows ? (event) => { event.preventDefault(); gridAction({type: 'pasteText', text: event.clipboardData.getData('text/plain')}); } : undefined}>
                      {busy === '読込' ? '読み込み中…' : isSales ? '表はまだ空です。「行を足す」で入力するか、左の「原本（Excel・CSV）から読む」で取り込みます。この枠を選んで Ctrl+V を押すと、Excelの範囲を行として貼り付けられます（左端は「報告キー」の列）。' : '表示する行がありません。'}
                      {isSales && canAddRows && !busy && <button type="button" className="secondary wb-small" onClick={addRow}>行を足す</button>}
                    </div>
                  )}
                <div className="wb-summary">
                  <span>{view ? `加工手順${view.stepCount}までの結果` : `変更 ${formatInt(diff.length)}件`}</span>
                  {!view && unsaved > 0 && <span className="wb-warn-text">未保存 {formatInt(unsaved)}件</span>}
                  {issues.size > 0 && <span className="wb-warn-text">入力の注意 {formatInt(issues.size)}件</span>}
                  {errorCount > 0 && <span className="wb-bad">検証エラー {formatInt(errorCount)}件</span>}
                </div>
                <ErrorList errors={errors} onJump={jumpTo} />
                {!view && diff.length > 0 && (
                  <details className="wb-diff">
                    <summary>変更の内容を見る（{formatInt(diff.length)}件）</summary>
                    <table>
                      <thead><tr><th scope="col">種類</th><th scope="col">行</th><th scope="col">変更</th></tr></thead>
                      <tbody>
                        {diff.slice(0, 100).map((item) => (
                          <tr key={item.key}>
                            <td>{item.kind}</td>
                            <td className="num">{numbers.get(item.key) ? `${numbers.get(item.key)}行目` : '—'}</td>
                            <td>{changeText(item, allGridCols)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                    {diff.length > 100 && <p className="wb-muted">ほか{formatInt(diff.length - 100)}件</p>}
                  </details>
                )}
              </>
            )}
        </section>

        {!access.locked && steps.length > 0 && (
          <aside className="wb-right" aria-label="加工手順">
            <header>
              <h3>加工手順（{formatInt(steps.length)}）</h3>
              <button type="button" className="wb-small" disabled={Boolean(busy) || previewOnly} onClick={() => preview()}>最終結果を見る</button>
            </header>
            <p className="wb-muted">原本の行は変えずに、加工した結果だけを確かめられます。保存すると下書きに手順も残ります。</p>
            <div className="recipe">
              <input value={recipeName} onChange={(event) => setRecipeName(event.target.value)} placeholder="加工手順の名前" aria-label="加工手順の名前" />
              <button type="button" className="secondary wb-small" disabled={!steps.length || !recipeName.trim() || Boolean(busy) || previewOnly} onClick={saveRecipe}>加工手順を保存</button>
            </div>
            {steps.map((s, i) => (
              <article className="transform-step" key={s.step_id}>
                <button type="button" className="step-title" onClick={() => preview(i + 1)} disabled={previewOnly}>{i + 1}. {OPS[s.operation]}（ここまでの結果を見る）</button>
                <Param value={s} cols={base.columns || []} datasets={sets.filter((d) => lookups[d.key])} disabled={Boolean(draft && draft.status !== 'draft')}
                  onChange={(n) => { setSteps((x) => x.map((q, j) => (j === i ? n : q))); invalidate(); }} />
                <footer>
                  <button type="button" className="secondary wb-small" disabled={Boolean(draft && draft.status !== 'draft')} onClick={() => { setSteps((x) => x.filter((_, j) => j !== i)); invalidate(); }}>この手順を消す</button>
                  <button type="button" className="secondary wb-small" disabled={!i || Boolean(draft && draft.status !== 'draft')} onClick={() => { setSteps((x) => x.map((q, j) => (j === i ? x[i - 1] : j === i - 1 ? x[i] : q))); invalidate(); }}>上へ</button>
                </footer>
              </article>
            ))}
          </aside>
        )}
      </div>

      {!access.locked && (
        <section className="wb-approval" aria-label="検証・承認・反映">
          <div>
            <h3>検証・承認・反映</h3>
            <p>
              {changeSet
                ? `状態: ${statusText(application ? 'applied' : changeSet.status)}${changeSet.createdAt ? `（申請 ${dateTimeJst(changeSet.createdAt)}）` : ''}${changeSet.approvedAt ? `・承認 ${dateTimeJst(changeSet.approvedAt)}` : ''}`
                : draft ? `下書き 第${draft.revision}版${draft.dirty ? '（保存していない変更あり）' : ''}` : '下書きはまだ保存していません'}
            </p>
            <p className="wb-muted">保存した同じ版の全行を検証し、承認を申請します。管理者が承認すると業務データへ反映できます。</p>
          </div>
          <div className="wb-approval-actions">
            <button type="button" className="secondary" onClick={save} disabled={Boolean(busy) || previewOnly || (draft && draft.status !== 'draft') || (!draft && unsaved === 0 && !steps.length)}>下書きを保存する</button>
            <button type="button" className="secondary" onClick={validate} disabled={Boolean(busy) || previewOnly || !draft || draft.status !== 'draft' || draft.dirty}>全件を検証する</button>
            <label>変更理由<input ref={reasonRef} value={reason} disabled={Boolean(changeSet)} onChange={(event) => setReason(event.target.value)} placeholder="例: 作品名の誤字を直す" /></label>
            <button type="button" onClick={submit} disabled={Boolean(busy) || previewOnly || !validation || errorCount > 0 || !reason.trim() || Boolean(changeSet)}>承認を申請する</button>
            {role === 'admin' && <button type="button" onClick={approve} disabled={Boolean(busy) || previewOnly || changeSet?.status !== 'submitted'}>承認する</button>}
            <button type="button" onClick={apply} disabled={Boolean(busy) || previewOnly || changeSet?.status !== 'approved' || Boolean(application)}>DBへ反映する</button>
            {(changeSet || application) && <button type="button" className="secondary" disabled={Boolean(busy)} onClick={restart}>新しい下書きで続けて編集</button>}
          </div>
        </section>
      )}

      {!access.locked && <details className="wb-tech">
        <summary>技術情報（照合用）</summary>
        <dl>
          <dt>データセット</dt><dd>{dataset}</dd>
          <dt>固定版（スナップショット）</dt><dd>{base.snapshot?.id || '—'}{base.snapshot?.capturedAt ? `（${dateTimeJst(base.snapshot.capturedAt)}）` : ''}</dd>
          {file?.sourceHash && <><dt>原本の SHA-256</dt><dd>{file.sourceHash}</dd></>}
          <dt>下書き</dt><dd>{draft?.id || '—'}</dd>
          <dt>検証</dt><dd>{validation?.id || '—'}{validation?.inputHash ? `／入力 ${validation.inputHash.slice(0, 16)}…` : ''}</dd>
          <dt>変更セット</dt><dd>{changeSet?.id || '—'}{changeSet?.hash ? `／内容 ${String(changeSet.hash).slice(0, 16)}…` : ''}</dd>
          {application?.id && <><dt>反映</dt><dd>{application.id}</dd></>}
        </dl>
        {view?.lineage?.length > 0 && (
          <>
            <p>加工結果の元データへの参照（先頭100行）</p>
            <pre>{JSON.stringify(view.lineage.slice(0, 100), null, 2)}</pre>
          </>
        )}
      </details>}
    </div>
  );
}

export default Workbench;
