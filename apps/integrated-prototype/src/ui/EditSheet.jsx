// 編集できる表（Excel の操作感の共通の部品）。行を並べて見る・直す画面に使う。
// 論理は edit-sheet-model.mjs（試験: test/edit-sheet-model.test.mjs）。この部品は状態（選択・編集中の文字・絞り込み・戻す履歴）と描画だけを持つ。
// 見た目の決まり: core の docs/design/integrated-system-visual.md §1〜§5・§7。UI指針: docs/design/ui-guidelines.md
// 使い方:
//   <EditSheet label="経費" sheets={[{id, label, columns, rows, editable, newRow(直前の行), status}]} onChange={({sheet, edits, rows, action}) => ...} />
//   変えたセルは edits で渡すだけ（rows は edits を当てた後の行）。保存の仕方（版・取消の行を足す）は呼び出し側が決める。
//   列は edit-sheet-model.mjs の sheetColumns の形。ID で結ぶ列は type:'lookup'（候補から選ぶ。onCreate(名前) で登録の道を出す）。
//   行ごとに候補を変えるときは列に candidatesFor(row)（無ければ options）。
//   onSelect({sheet, range, rowKeys, visibleKeys}) は選択か見えている行が変わるたびに呼ぶ（rowKeys は範囲に入っている行の鍵）。
//   historyEpoch を変えると戻すの履歴を空にする（保存して読み直したときに呼び出し側が進める）。
import React, {useEffect, useLayoutEffect, useMemo, useRef, useState} from 'react';
import {flushSync} from 'react-dom';
import {
  applyEdits, cellProblem, filterChoices, gridKeyAction, inRectangle, invertEdits, moveSelection, nextFilter, parseCell, pasteCells,
  rangeStats, rectangle, sheetCandidates, sheetCellText, sheetColumns, sheetEditText, sheetTotals, sheetView, tsvFor, writeCell,
  clearCells, fillDown, parseClipboard, columnForRow, historyAfterEpoch, rowHeadSelection, selectionInfo,
} from './edit-sheet-model.mjs';
import {int as formatInt, decimal as formatDecimal} from './format.mjs';
import './edit-sheet.css';

const HISTORY_LIMIT = 50;
const ROW_HEAD = 44;
const ARROWS = {ArrowUp: [-1, 0], ArrowDown: [1, 0], ArrowLeft: [0, -1], ArrowRight: [0, 1]};
const EMPTY_VIEW = {selection: {anchor: {r: 0, c: 0}, focus: {r: 0, c: 0}}, filters: {}, sort: null};
const isPick = (column) => column?.type === 'choice' || column?.type === 'lookup';
const blankText = (text) => String(text ?? '').trim() === '';

function Badge({tone, children}) {
  if (!tone || children === '') return children;
  return <span className={`es-tag is-${tone}`}>{children}</span>;
}

export function EditSheet({label, sheets = [], sheet: sheetProp, onSheet, onChange, onSelect, historyEpoch, className = ''}) {
  const [ownSheet, setOwnSheet] = useState(sheets[0]?.id ?? null);
  const activeId = sheetProp ?? ownSheet;
  const sheet = sheets.find((item) => item.id === activeId) || sheets[0] || {id: null, columns: [], rows: []};
  const [views, setViews] = useState({});
  const [editing, setEditing] = useState(null);
  const [menu, setMenu] = useState(null);
  const [history, setHistory] = useState([]);
  const [notice, setNotice] = useState('');
  const [, setTick] = useState(0);
  const rootRef = useRef(null);
  const wrapRef = useRef(null);
  const inputRef = useRef(null);
  const menuRef = useRef(null);
  const ddRef = useRef(null);
  const dragging = useRef(false);
  const reveal = useRef(false);
  const editingRef = useRef(null);
  const epochRef = useRef(historyEpoch);
  const lastSelect = useRef('');
  editingRef.current = editing;
  // 同じ操作の中で2回渡すとき（確定してから下へ写す など）、2回目は1回目を当てた後の行から作る
  const latestRows = useRef({});
  for (const item of sheets) latestRows.current[item.id] = item.rows || [];
  const rowsOf = (id) => latestRows.current[id] || [];

  const columns = useMemo(() => sheetColumns(sheet.columns || [], {readOnly: !sheet.editable}), [sheet.columns, sheet.editable]);
  const viewState = views[sheet.id] || EMPTY_VIEW;
  const view = useMemo(() => sheetView(sheet.rows || [], columns, viewState), [sheet.rows, columns, viewState]);
  const appendable = Boolean(sheet.editable && typeof sheet.newRow === 'function');
  const rowCount = view.rows.length + (appendable ? 1 : 0);
  const bounds = {rows: rowCount, cols: columns.length};
  const clampSel = (selection) => {
    const fix = (p) => ({r: Math.max(0, Math.min(p.r, Math.max(0, rowCount - 1))), c: Math.max(0, Math.min(p.c, Math.max(0, columns.length - 1)))});
    return {anchor: fix(selection.anchor), focus: fix(selection.focus)};
  };
  const selection = clampSel(viewState.selection);
  const rect = rectangle(selection.anchor, selection.focus);
  const active = selection.focus;
  const single = rect.r1 === rect.r2 && rect.c1 === rect.c2;
  const editColumn = editing ? columnForRow(columns[editing.c], view.rows[editing.r] || null) : null;
  const candidates = useMemo(() => (editing && isPick(editColumn) && editing.open ? sheetCandidates(editColumn, editing.typed ? editing.text : '') : null),
    [editing, editColumn]);
  const totals = useMemo(() => sheetTotals(view.rows, columns), [view.rows, columns]);
  const stats = rangeStats(view.rows, columns, rect);
  const domId = (r, c) => `es-${sheet.id}-${r}-${c}`;

  const setView = (patch) => setViews((current) => {
    const base = current[sheet.id] || EMPTY_VIEW;
    return {...current, [sheet.id]: {...base, ...(typeof patch === 'function' ? patch(base) : patch)}};
  });
  const setSelection = (next) => setView((base) => ({selection: typeof next === 'function' ? next(clampSel(base.selection)) : next}));
  const focusGrid = () => { try { wrapRef.current?.focus({preventScroll: true}); } catch { /* 焦点を持てない */ } };
  const writable = (r, c) => Boolean(sheet.editable && columns[c]?.editable && (r < view.rows.length || appendable));

  // 戻す履歴に積み、呼び出し側へ渡す。戻すときは逆向きの edits を前へ当てる形で渡す。
  function emit(edits, action, target = sheet) {
    if (!edits.length) return;
    const rows = applyEdits(rowsOf(target.id), edits);
    latestRows.current[target.id] = rows;
    onChange?.({sheet: target.id, edits, rows, action});
    if (action !== 'undo') setHistory((list) => [...list, {sheet: target.id, edits}].slice(-HISTORY_LIMIT));
  }

  function undo() {
    if (editingRef.current) setEditing(null);
    const entry = history.at(-1);
    if (!entry) return;
    const target = sheets.find((item) => item.id === entry.sheet);
    setHistory((list) => list.slice(0, -1));
    if (target) emit(invertEdits(entry.edits), 'undo', target);
    setNotice('');
  }

  function startEdit(r, c, {mode = 'keep', text = ''} = {}) {
    if (!writable(r, c)) return false;
    const column = columns[c];
    const row = view.rows[r] || null;
    setNotice('');
    // 打ち始めた文字があれば、候補の先頭を選んでおく（Enter でそれに決まる）
    setEditing({r, c, mode, text: mode === 'keep' ? sheetEditText(column, row) : text, typed: mode !== 'keep', open: isPick(column), hi: isPick(column) && mode !== 'keep' && text.trim() ? 0 : -1, error: ''});
    return true;
  }

  function cancel() {
    setEditing(null);
    focusGrid();
  }

  // 確定。型に合わない値は入れず、編集のまま赤の細い枠にする。
  function commit(move = null, chosen) {
    const current = editingRef.current;
    if (!current) return true;
    const column = columnForRow(columns[current.c], view.rows[current.r] || null);
    const list = current.open && isPick(column) ? sheetCandidates(column, current.typed ? current.text : '').options : [];
    let parsed;
    if (chosen !== undefined) parsed = {ok: true, value: chosen};
    else if (current.hi >= 0 && list[current.hi]) parsed = {ok: true, value: list[current.hi].value};
    else parsed = parseCell(column, current.text);
    if (!parsed.ok) {
      setEditing({...current, error: parsed.error});
      return false;
    }
    setEditing(null);
    const blankNewRow = current.r >= view.rows.length && blankText(parsed.value);
    if (!blankNewRow) {
      const result = writeCell(rowsOf(sheet.id), view.keys, columns, {r: current.r, c: current.c}, parsed.value, {makeRow: sheet.newRow});
      emit(result.edits, 'edit');
    }
    if (move) {
      reveal.current = true;
      setSelection((sel) => moveSelection(sel, {type: 'commit', ...move}, {rows: rowCount + (current.r >= view.rows.length && !blankNewRow ? 1 : 0), cols: columns.length}));
    }
    focusGrid();
    return true;
  }

  async function createOption(name) {
    const current = editingRef.current;
    const column = current ? columns[current.c] : null;
    if (!column?.onCreate) return;
    const made = await column.onCreate(name);
    if (made == null || !editingRef.current) return;
    commit({dr: 1, dc: 0}, typeof made === 'object' ? String(made.value ?? made.id) : String(made));
  }

  function clearRange() {
    if (!sheet.editable) return;
    const result = clearCells(rowsOf(sheet.id), view.keys, columns, rect);
    emit(result.edits, 'clear');
  }

  function fill() {
    if (!sheet.editable) return;
    if (!commit()) return;
    const result = fillDown(rowsOf(sheet.id), view.keys, columns, rect);
    emit(result.edits, 'fill');
  }

  function paste(text) {
    if (!sheet.editable) return;
    const result = pasteCells(rowsOf(sheet.id), view.keys, columns, selection, text, {
      allowAppend: appendable, makeRow: (i, previous) => sheet.newRow(previous), read: (column, text, row) => parseCell(columnForRow(column, row), text),
      appendHint: '行を足せない表です',
    });
    if (!result.ok) {
      setNotice(result.message);
      return;
    }
    emit(result.edits, 'paste');
    setNotice(result.rejected ? `入らず ${formatInt(result.rejected)}` : '');
    // 貼った範囲を選んだままにする（1セルを範囲に貼ったときは範囲のまま）
    const matrix = parseClipboard(text);
    if (matrix.length > 1 || matrix[0].length > 1) {
      const width = Math.max(...matrix.map((line) => line.length));
      const focus = {r: rect.r1 + matrix.length - 1, c: Math.min(columns.length - 1, rect.c1 + width - 1)};
      setViews((current) => ({...current, [sheet.id]: {...(current[sheet.id] || EMPTY_VIEW), selection: {anchor: {r: rect.r1, c: rect.c1}, focus}}}));
    }
  }

  function switchSheet(id) {
    if (!commit()) return;
    setMenu(null);
    if (sheetProp === undefined) setOwnSheet(id);
    onSheet?.(id);
  }

  // ── キー ──
  function onKeyDown(event) {
    if (menu) {
      if (event.key === 'Escape') {
        event.preventDefault();
        setMenu(null);
        focusGrid();
      }
      return;
    }
    if (editing) {
      if (event.nativeEvent?.isComposing || event.keyCode === 229) return;
      const list = candidates?.options || [];
      if (list.length && (event.key === 'ArrowDown' || event.key === 'ArrowUp')) {
        event.preventDefault();
        const step = event.key === 'ArrowDown' ? 1 : -1;
        setEditing((current) => ({...current, hi: (current.hi + step + list.length) % list.length, error: ''}));
        return;
      }
      const action = gridKeyAction(event, {editing: true});
      if (action.type === 'cancel') {
        event.preventDefault();
        cancel();
      } else if (action.type === 'commit') {
        event.preventDefault();
        commit({dr: action.dr, dc: action.dc});
      } else if (editing.mode === 'over' && ARROWS[event.key] && !list.length) {
        event.preventDefault();
        commit({dr: ARROWS[event.key][0], dc: ARROWS[event.key][1]});
      }
      return;
    }
    if (!columns.length || !rowCount) return;
    const command = event.ctrlKey || event.metaKey;
    // 日本語入力の始まり: 入力欄を開き、変換中の文字をそのまま受ける
    if ((event.keyCode === 229 || event.key === 'Process') && writable(active.r, active.c)) {
      flushSync(() => startEdit(active.r, active.c, {mode: 'over', text: ''}));
      inputRef.current?.focus();
      return;
    }
    // Excel と同じく、Enter は下へ（Shift で上へ）移る。直すのは F2・2回押す・打ち始め
    if (event.key === 'Enter' && !command && !event.altKey) {
      event.preventDefault();
      reveal.current = true;
      setSelection((sel) => moveSelection(sel, {type: 'move', dr: event.shiftKey ? -1 : 1, dc: 0}, bounds));
      return;
    }
    const action = gridKeyAction(event, {readOnly: !sheet.editable});
    switch (action.type) {
      case 'edit':
        event.preventDefault();
        if (action.keep) startEdit(active.r, active.c, {mode: 'keep'});
        else startEdit(active.r, active.c, {mode: 'over', text: action.text});
        return;
      case 'move':
        if (event.key === 'Tab' && ((action.dc > 0 && active.c >= columns.length - 1) || (action.dc < 0 && active.c <= 0))) return;
      // fallthrough
      case 'moveTo':
      case 'selectAll':
      case 'collapse':
        event.preventDefault();
        reveal.current = true;
        setNotice('');
        setSelection((sel) => moveSelection(sel, action, bounds));
        return;
      case 'clear':
        event.preventDefault();
        clearRange();
        return;
      case 'undo':
        event.preventDefault();
        undo();
        return;
      case 'fillDown':
        event.preventDefault();
        fill();
        return;
      case 'readonly':
        event.preventDefault();
        return;
      default:
    }
  }

  function onCopy(event) {
    if (editing || menu) return;
    event.preventDefault();
    event.clipboardData.setData('text/plain', tsvFor(view.rows, columns, rect, sheetCellText));
  }

  function onPaste(event) {
    if (editing || menu) return;
    event.preventDefault();
    paste(event.clipboardData.getData('text/plain'));
  }

  // ── 指とマウス ──
  function onCellDown(event, r, c) {
    if (event.button !== 0) return;
    if (editing) {
      if (editing.r === r && editing.c === c) return;
      if (!commit()) {
        event.preventDefault();
        return;
      }
    }
    const mouse = event.pointerType === 'mouse';
    const again = !mouse && single && active.r === r && active.c === c && !event.shiftKey;
    if (mouse) {
      event.preventDefault();
      dragging.current = true;
    }
    setNotice('');
    if (again) {
      // 指: 選んでいるセルをもう1回押すと直す（キーボードが無くても直せる）。押した手の中で入力欄へ焦点を移す（iPad のキーボードを出すため）
      flushSync(() => startEdit(r, c, {mode: 'keep'}));
      inputRef.current?.focus({preventScroll: true});
      return;
    }
    setSelection((sel) => (event.shiftKey ? {anchor: sel.anchor, focus: {r, c}} : {anchor: {r, c}, focus: {r, c}}));
    if (mouse) focusGrid();
  }

  function onHeadDown(event, c) {
    if (event.target.closest('button')) return;
    if (!commit()) return;
    if (event.pointerType === 'mouse') event.preventDefault();
    setSelection({anchor: {r: 0, c}, focus: {r: Math.max(0, rowCount - 1), c}});
    focusGrid();
  }

  function onRowHeadDown(event, r) {
    if (!commit()) return;
    if (event.pointerType === 'mouse') event.preventDefault();
    setSelection((sel) => rowHeadSelection(sel, r, columns.length, {extend: event.shiftKey}));
    focusGrid();
  }

  function openMenu(event, c) {
    event.preventDefault();
    if (!commit()) return;
    if (menu?.c === c) {
      setMenu(null);
      return;
    }
    const root = rootRef.current.getBoundingClientRect();
    const button = event.currentTarget.getBoundingClientRect();
    const column = columns[c];
    const choices = filterChoices(sheet.rows || [], column);
    const current = viewState.filters[column.key];
    setMenu({
      c, choices, picked: current ? [...current] : [...choices],
      left: Math.max(0, Math.min(button.right - root.left - 240, root.width - 240)), top: button.bottom - root.top,
    });
  }

  function pickFilter(text, on) {
    const column = columns[menu.c];
    const picked = on ? [...new Set([...menu.picked, text])] : menu.picked.filter((item) => item !== text);
    setMenu({...menu, picked});
    const filter = nextFilter(menu.choices, picked);
    setView((base) => {
      const filters = {...base.filters};
      if (filter) filters[column.key] = filter;
      else delete filters[column.key];
      return {filters};
    });
  }

  function sortBy(dir) {
    const column = columns[menu.c];
    setView({sort: dir ? {key: column.key, dir} : null});
    setMenu(null);
    focusGrid();
  }

  function clearFilter() {
    const column = columns[menu.c];
    setView((base) => {
      const filters = {...base.filters};
      delete filters[column.key];
      return {filters, sort: base.sort?.key === column.key ? null : base.sort};
    });
    setMenu(null);
    focusGrid();
  }

  // 呼び出し側が historyEpoch を進めたら、戻すの履歴を空にする
  useEffect(() => {
    const previous = epochRef.current;
    epochRef.current = historyEpoch;
    setHistory((list) => historyAfterEpoch(list, previous, historyEpoch));
  }, [historyEpoch]);
  // 選択か見えている行が変わったら呼び出し側へ渡す（同じ中身なら呼ばない）
  useEffect(() => {
    if (typeof onSelect !== 'function') return;
    const info = selectionInfo(rect, view.keys);
    const text = JSON.stringify([sheet.id, info]);
    if (lastSelect.current === text) return;
    lastSelect.current = text;
    onSelect({sheet: sheet.id, ...info});
  });
  useEffect(() => {
    const stop = () => { dragging.current = false; };
    window.addEventListener('pointerup', stop);
    return () => window.removeEventListener('pointerup', stop);
  }, []);
  useEffect(() => {
    if (!menu) return undefined;
    const close = (event) => {
      if (menuRef.current?.contains(event.target) || event.target.closest?.('.es-fbtn')) return;
      setMenu(null);
    };
    document.addEventListener('pointerdown', close, true);
    return () => document.removeEventListener('pointerdown', close, true);
  }, [menu]);
  // 編集を始めたら入力欄へ焦点を移し、カーソルを末尾に置く
  useEffect(() => {
    if (!editing) return;
    const input = inputRef.current;
    if (input && document.activeElement !== input) {
      input.focus({preventScroll: true});
      try { input.setSelectionRange(input.value.length, input.value.length); } catch { /* 選択を持てない入力欄 */ }
    }
  }, [editing?.r, editing?.c, editing?.mode]);
  // キーで動かしたら、選んだセルを見える所へ送る
  useEffect(() => {
    if (!reveal.current) return;
    reveal.current = false;
    const cell = document.getElementById(domId(active.r, active.c));
    const wrap = wrapRef.current;
    if (!cell || !wrap) return;
    const box = wrap.getBoundingClientRect();
    const at = cell.getBoundingClientRect();
    const head = wrap.querySelector('thead')?.getBoundingClientRect().height || 0;
    const foot = wrap.querySelector('tfoot')?.getBoundingClientRect().height || 0;
    const lead = ROW_HEAD + (columns[0]?.width || 0);
    if (at.top < box.top + head) wrap.scrollTop -= box.top + head - at.top;
    else if (at.bottom > box.bottom - foot) wrap.scrollTop += at.bottom - (box.bottom - foot);
    if (active.c > 0 && at.left < box.left + lead) wrap.scrollLeft -= box.left + lead - at.left;
    else if (at.right > box.right) wrap.scrollLeft += at.right - box.right;
  });
  // 候補の一覧は、直しているセルの下に置く（表の枠の外へはみ出してよい）
  useLayoutEffect(() => {
    const dd = ddRef.current;
    if (!dd || !editing) return;
    const cell = document.getElementById(domId(editing.r, editing.c));
    const root = rootRef.current;
    if (!cell || !root) return;
    const box = root.getBoundingClientRect();
    const at = cell.getBoundingClientRect();
    dd.style.left = `${Math.max(0, Math.min(at.left - box.left, box.width - dd.offsetWidth))}px`;
    dd.style.top = `${at.bottom - box.top}px`;
    dd.style.minWidth = `${at.width}px`;
  });

  const tableWidth = columns.reduce((sum, column) => sum + column.width, ROW_HEAD);
  const activeColumn = columns[active.c];
  const activeRow = view.rows[active.r] || null;
  const fxText = editing ? editing.text : activeRow && activeColumn ? sheetCellText(activeColumn, activeRow) : '';
  const average = stats.average === null ? '' : stats.yen ? formatInt(stats.average) : formatDecimal(stats.average, {digits: 1});
  const menuColumn = menu ? columns[menu.c] : null;
  const list = candidates?.options || [];

  return (
    <section ref={rootRef} className={`es ${className}`.trim()} aria-label={label}>
      <div className="es-fx">
        <span className="es-name" aria-label="選んだセル">{activeColumn ? `${activeColumn.label} ${active.r + 1}` : ''}</span>
        <span className="es-value" aria-label="中身">{fxText}</span>
        <span className="es-tools">
          <button type="button" disabled={!history.length} onClick={() => { undo(); focusGrid(); }}>戻す</button>
          <button type="button" disabled={!sheet.editable} onClick={() => { fill(); focusGrid(); }}>下へ</button>
          <button type="button" disabled={!sheet.editable} onClick={() => { if (commit()) clearRange(); focusGrid(); }}>消す</button>
        </span>
      </div>
      <div ref={wrapRef} className="es-wrap" role="grid" tabIndex={0} aria-label={sheet.label || label}
        aria-rowcount={rowCount + 1} aria-colcount={columns.length + 1} aria-multiselectable="true" aria-readonly={!sheet.editable || undefined}
        aria-activedescendant={editing ? undefined : domId(active.r, active.c)}
        onKeyDown={onKeyDown} onCopy={onCopy} onPaste={onPaste} onScroll={() => { setMenu(null); if (editing) setTick((n) => n + 1); }}>
        <table className="es-grid" style={{width: tableWidth}}>
          <colgroup>
            <col style={{width: ROW_HEAD}} />
            {columns.map((column) => <col key={column.key} style={{width: column.width}} />)}
          </colgroup>
          <thead>
            <tr role="row">
              <th className="es-rh" role="columnheader" aria-label="行" />
              {columns.map((column, c) => {
                const filtered = Boolean(viewState.filters[column.key]);
                const sorted = viewState.sort?.key === column.key ? viewState.sort.dir : null;
                return (
                  <th key={column.key} role="columnheader" className={[c === 0 ? 'is-first' : '', c >= rect.c1 && c <= rect.c2 ? 'is-hl' : '', column.numeric ? 'is-num' : ''].filter(Boolean).join(' ')}
                    aria-sort={sorted === 'asc' ? 'ascending' : sorted === 'desc' ? 'descending' : undefined}
                    onPointerDown={(event) => onHeadDown(event, c)}>
                    <div className="es-hd">
                      <span className="es-lb">{column.label}</span>
                      {sorted && <span className="es-tag">{sorted === 'asc' ? '昇' : '降'}</span>}
                      {filtered && <span className="es-tag">絞り</span>}
                      <button type="button" className="es-fbtn" aria-label={`${column.label} 並べ替え・絞り込み`} aria-expanded={menu?.c === c}
                        onClick={(event) => openMenu(event, c)}>▼</button>
                    </div>
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {Array.from({length: rowCount}, (_, r) => {
              const row = view.rows[r] || null;
              const rowSelected = r >= rect.r1 && r <= rect.r2;
              return (
                <tr key={view.keys[r] ?? '__new'} role="row" className={row ? '' : 'is-new'}>
                  <th scope="row" role="rowheader" className={`es-rh${rowSelected ? ' is-hl' : ''}`} onPointerDown={(event) => onRowHeadDown(event, r)}>{row ? r + 1 : ''}</th>
                  {columns.map((column, c) => {
                    const isActive = active.r === r && active.c === c;
                    const isEditing = editing?.r === r && editing?.c === c;
                    const problem = row ? cellProblem(column, row) : '';
                    const text = row ? sheetCellText(column, row) : '';
                    const ranged = !single && inRectangle(r, c, rect);
                    const canWrite = writable(r, c);
                    const className = [c === 0 ? 'is-first' : '', column.numeric ? 'is-num' : '', canWrite ? '' : 'is-ro', ranged ? 'is-range' : '',
                      isActive ? 'is-active' : '', problem || (isEditing && editing.error) ? 'is-bad' : '', isPick(column) && canWrite ? 'is-pick' : '']
                      .filter(Boolean).join(' ');
                    return (
                      <td key={column.key} id={domId(r, c)} role="gridcell" className={className} aria-selected={inRectangle(r, c, rect)}
                        aria-readonly={!canWrite || undefined} aria-invalid={problem || (isEditing && editing.error) ? true : undefined}
                        aria-label={`${row ? r + 1 : '新しい行'} ${column.label} ${text || '空欄'}${problem ? ` ${problem}` : ''}`}
                        title={problem || undefined}
                        onPointerDown={(event) => onCellDown(event, r, c)}
                        onMouseEnter={() => { if (dragging.current && !editing) setSelection((sel) => ({anchor: sel.anchor, focus: {r, c}})); }}
                        onDoubleClick={() => { if (!editing) startEdit(r, c, {mode: 'keep'}); }}>
                        {isEditing
                          ? <input ref={inputRef} className="es-ed" value={editing.text} aria-label={`${column.label} ${row ? r + 1 : '新しい行'}を直す`}
                            aria-invalid={editing.error ? true : undefined} title={editing.error || undefined}
                            inputMode={column.type === 'int' || column.type === 'yen' ? 'numeric' : undefined} autoComplete="off" spellCheck={false}
                            onChange={(event) => setEditing((current) => ({...current, text: event.target.value, typed: true, open: isPick(column), hi: isPick(column) && event.target.value.trim() ? 0 : -1, error: ''}))} />
                          : <Badge tone={row && column.badge ? column.badge(row) : null}>{text}</Badge>}
                      </td>
                    );
                  })}
                </tr>
              );
            })}
          </tbody>
          {columns.some((column) => column.total === 'sum') || view.rows.length ? (
            <tfoot>
              <tr role="row">
                <th scope="row" role="rowheader" className="es-rh">計</th>
                {columns.map((column, c) => (
                  <td key={column.key} role="gridcell" className={[c === 0 ? 'is-first' : '', column.numeric ? 'is-num' : ''].filter(Boolean).join(' ')}>
                    {column.total === 'sum' ? formatInt(totals[column.key] ?? 0) : c === 0 ? `${formatInt(view.rows.length)}件` : ''}
                  </td>
                ))}
              </tr>
            </tfoot>
          ) : null}
        </table>
      </div>
      {editing && candidates && (list.length > 0 || candidates.create) && (
        <div ref={ddRef} className="es-dd" role="listbox" aria-label={`${editColumn.label}の候補`}
          onPointerDown={(event) => { if (event.pointerType === 'mouse') event.preventDefault(); }}>
          {list.map((option, i) => (
            <button key={option.value} type="button" role="option" aria-selected={i === editing.hi}
              onClick={() => { commit({dr: 1, dc: 0}, option.value); }}>{option.label}</button>
          ))}
          {candidates.create && (
            <button type="button" className="es-new" onClick={() => createOption(candidates.create)}>新規 {candidates.create}</button>
          )}
        </div>
      )}
      {menu && menuColumn && (
        <div ref={menuRef} className="es-menu" role="dialog" aria-label={`${menuColumn.label} 並べ替え・絞り込み`} style={{left: menu.left, top: menu.top}}>
          <button type="button" onClick={() => sortBy('asc')}>昇順</button>
          <button type="button" onClick={() => sortBy('desc')}>降順</button>
          <div className="es-mv">
            {menu.choices.map((text) => (
              <label key={text}>
                <input type="checkbox" checked={menu.picked.includes(text)} onChange={(event) => pickFilter(text, event.target.checked)} />
                <span>{text === '' ? '空白' : text}</span>
              </label>
            ))}
          </div>
          <button type="button" onClick={clearFilter}>外す</button>
        </div>
      )}
      <div className="es-foot">
        {sheets.length > 1 && (
          <div className="es-tabs" role="group" aria-label="シート">
            {sheets.map((item) => (
              <button key={item.id} type="button" aria-pressed={item.id === sheet.id} onClick={() => switchSheet(item.id)}>{item.label}</button>
            ))}
          </div>
        )}
        <div className="es-stat" aria-live="polite">
          {sheet.status ? <span className="es-eq">{sheet.status}</span> : null}
          {notice ? <span className="es-stop" role="status">{notice}</span> : null}
          {single ? null : stats.count > 0
            ? <>
              <span>合計 <b>{formatInt(stats.sum)}</b></span>
              <span>件数 <b>{formatInt(stats.count)}</b></span>
              <span>平均 <b>{average}</b></span>
            </>
            : <span>件数 <b>{formatInt(stats.filled)}</b></span>}
        </div>
      </div>
    </section>
  );
}

export default EditSheet;
