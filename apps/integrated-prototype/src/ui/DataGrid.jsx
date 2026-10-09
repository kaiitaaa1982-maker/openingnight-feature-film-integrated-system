// 共通の表（スプレッドシート表示）。見出しと先頭の固定列を残したまま縦横にスクロールし、
// 並べ替え（▲▼）・列ごとの絞込・全体検索・列の表示切替・絞込範囲の合計・小計・行の詳細展開・Excel/CSV/印刷の出力を持つ。
// 列に group（まとまりの名前）を持たせると見出しを2段にする（1段目は隣り合う同じ group をまとめた colSpan、2段目は列名）。
// group の無い表は今までどおり1段の見出し。出力と「表示する列」では列名を「<group> <列名>」にする。
// ページングはしない。2,000行を超えたら先頭2,000行だけを描き、件数を示して絞込を促す（合計と出力は全行）。
// footerRow（{label, values:{列キー: 表示文字}}）を渡すと、表の中で足した合計の代わりにその行を合計行に出す（サーバーが全行から作った合計など）。
// 論理は grid-model.mjs（node で試験）にあり、この部品は状態と描画だけを持つ。
import React, {useLayoutEffect, useMemo, useRef, useState} from 'react';
import {
  sortRows, filterRows, totalsFor, withSubtotals, limitItems, rowCellText, valueOf, isNumericColumn, hasDomain,
  totalText, totalMode, countText, gridSheetSpec, ignoresRowToggle, NULL_FILTER, RENDER_LIMIT,
} from './grid-model.mjs';
import {optionsOf, isKnownCode, labelOf} from './labels.mjs';
import {int, isBlank, toNumber, UNKNOWN_TEXT, BLANK_ZERO_TEXT} from './format.mjs';
import ReportOutputBar from './ReportOutputBar.jsx';
import './data-grid.css';

const NULL_OPTION = '__null__';
const storageKey = (key) => `on-grid:${key}`;

function readOverrides(persistKey) {
  if (!persistKey) return {};
  try {
    const saved = JSON.parse(window.localStorage.getItem(storageKey(persistKey)) || 'null');
    return saved && typeof saved.hidden === 'object' && !Array.isArray(saved.hidden) ? saved.hidden : {};
  } catch {
    return {};
  }
}

function writeOverrides(persistKey, overrides) {
  if (!persistKey) return;
  try {
    window.localStorage.setItem(storageKey(persistKey), JSON.stringify({hidden: overrides}));
  } catch {
    // 保存できない環境（プライベートモード等）では、この画面の中だけで切り替える
  }
}

const isActiveFilter = (filter) => !(filter === undefined || filter === '' || (Array.isArray(filter) && filter.length === 0));

function filterPlaceholder(column) {
  if (isNumericColumn(column)) return '例: >=10000';
  if (column.type === 'date' || column.type === 'month' || column.type === 'datetime') return '例: 2026-09';
  return '含む文字';
}

function FilterControl({column, value, onChange, rows}) {
  const label = `${column.label ?? column.key}で絞り込む`;
  if (hasDomain(column)) {
    const unknown = new Set();
    let hasNull = false;
    for (const row of rows) {
      const raw = valueOf(column, row);
      if (isBlank(raw) || raw === '') hasNull = true;
      else if (!isKnownCode(column.domain, raw)) unknown.add(String(raw));
    }
    const selected = Array.isArray(value) && value.length ? (value[0] === NULL_FILTER ? NULL_OPTION : String(value[0])) : '';
    return (
      <select aria-label={label} value={selected} onChange={(event) => {
        const next = event.target.value;
        onChange(next === '' ? undefined : next === NULL_OPTION ? [NULL_FILTER] : [next]);
      }}>
        <option value="">すべて</option>
        {optionsOf(column.domain).map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
        {[...unknown].map((code) => <option key={`u:${code}`} value={code}>{labelOf(column.domain, code)}</option>)}
        {hasNull && <option value={NULL_OPTION}>{UNKNOWN_TEXT}（空欄）</option>}
      </select>
    );
  }
  return (
    <input type="search" aria-label={label} placeholder={filterPlaceholder(column)} value={typeof value === 'string' ? value : ''}
      onChange={(event) => onChange(event.target.value === '' ? undefined : event.target.value)} />
  );
}

// 行の詳細は、表が横に長くても見えている幅に収め、横スクロールしても左端に留める（詳細の中のボタンが隠れないように）
function DetailFrame({children}) {
  const ref = useRef(null);
  const [width, setWidth] = useState(null);
  useLayoutEffect(() => {
    const scroller = ref.current?.closest?.('.dg-scroll');
    if (!scroller) return undefined;
    const measure = () => setWidth(Math.max(260, scroller.clientWidth - 32));
    measure();
    if (typeof ResizeObserver === 'undefined') return undefined;
    const observer = new ResizeObserver(measure);
    observer.observe(scroller);
    return () => observer.disconnect();
  }, []);
  return <div ref={ref} className="dg-detail-frame" style={width ? {width} : undefined}>{children}</div>;
}

export function DataGrid({
  columns = [], rows = [], rowKey, emptyText = 'まだ登録がありません', blankZero = true, groupBy, subtotalLabel,
  showTotals = true, totalLabel, onRowClick, renderDetail, exportSpec, toolbar, maxHeight = '70vh', initialSort,
  persistKey, ariaLabel, className = '', expandRequest, footerRow,
}) {
  const list = Array.isArray(rows) ? rows : [];
  const [overrides, setOverrides] = useState(() => readOverrides(persistKey));
  const [filters, setFilters] = useState({});
  const [query, setQuery] = useState('');
  const [showFilters, setShowFilters] = useState(false);
  const [sort, setSort] = useState(() => (initialSort?.key ? {key: initialSort.key, dir: initialSort.dir === 'desc' ? 'desc' : 'asc'} : null));
  const [expanded, setExpanded] = useState(() => new Set());
  // 外から行を開く（例: 月のセルを押したらその行の明細を開く）。{key, nonce} の nonce が変わるたびに開く
  const expandNonce = expandRequest?.nonce;
  useLayoutEffect(() => {
    if (expandRequest?.key === undefined || expandRequest?.key === null) return;
    setExpanded((previous) => (previous.has(expandRequest.key) ? previous : new Set(previous).add(expandRequest.key)));
  }, [expandNonce]); // eslint-disable-line react-hooks/exhaustive-deps
  const [activePos, setActivePos] = useState(0);
  const headRowRef = useRef(null);
  const groupRowRef = useRef(null);
  const bodyRef = useRef(null);
  const [offsets, setOffsets] = useState({});
  const [groupHeight, setGroupHeight] = useState(0);

  const effective = useMemo(
    () => columns.map((column) => ({...column, hidden: Object.hasOwn(overrides, column.key) ? Boolean(overrides[column.key]) : Boolean(column.hidden)})),
    [columns, overrides],
  );
  const visible = useMemo(() => effective.filter((column) => !column.hidden), [effective]);
  // 2段の見出しの1段目（隣り合う同じ group をまとめる）。group の列が1つも見えていなければ null（1段の見出し）
  const groupCells = useMemo(() => {
    if (!visible.some((column) => column.group)) return null;
    const cells = [];
    for (const column of visible) {
      const label = column.group || '';
      const last = cells.at(-1);
      if (last && label && last.label === label) last.span += 1;
      else cells.push({label, span: 1, first: column});
    }
    return cells;
  }, [visible]);
  const searchColumns = useMemo(() => effective.map((column) => (column.hidden ? {...column, searchable: false} : column)), [effective]);
  const filtered = useMemo(() => filterRows(list, searchColumns, filters, query), [list, searchColumns, filters, query]);
  const sorted = useMemo(() => sortRows(filtered, effective, sort), [filtered, effective, sort]);
  const items = useMemo(
    () => (groupBy ? withSubtotals(sorted, effective, groupBy, subtotalLabel) : sorted.map((row) => ({type: 'row', row}))),
    [sorted, effective, groupBy, subtotalLabel],
  );
  const limited = useMemo(() => limitItems(items, RENDER_LIMIT), [items]);
  const totals = useMemo(() => totalsFor(filtered, visible), [filtered, visible]);
  const hasTotals = showTotals && visible.some((column) => totalMode(column) !== 'none');
  const originalIndex = useMemo(() => new Map(list.map((row, index) => [row, index])), [list]);
  const filtersActive = Object.values(filters).some(isActiveFilter) || query.trim() !== '';

  const keyFor = (row) => {
    const key = typeof rowKey === 'function' ? rowKey(row) : rowKey ? row?.[rowKey] : row?.id;
    return key === undefined || key === null ? `#${originalIndex.get(row)}` : String(key);
  };
  const dataRows = useMemo(() => limited.items.filter((item) => item.type === 'row').map((item) => item.row), [limited]);
  const active = Math.max(0, Math.min(activePos, dataRows.length - 1));

  const stickyKeys = visible.filter((column) => column.sticky).map((column) => column.key);
  const stickySignature = stickyKeys.join('\u0001');
  const lastSticky = stickyKeys.at(-1);
  useLayoutEffect(() => {
    const row = headRowRef.current;
    if (!row || !stickyKeys.length) {
      setOffsets((previous) => (Object.keys(previous).length ? {} : previous));
      return undefined;
    }
    const measure = () => {
      const next = {};
      let left = 0;
      for (const cell of row.children) {
        const key = cell.dataset.key;
        if (!stickyKeys.includes(key)) continue;
        next[key] = left;
        left += cell.getBoundingClientRect().width;
      }
      setOffsets((previous) => (stickyKeys.every((key) => previous[key] === next[key]) && Object.keys(previous).length === stickyKeys.length ? previous : next));
    };
    measure();
    if (typeof ResizeObserver === 'undefined') return undefined;
    const observer = new ResizeObserver(measure);
    for (const cell of row.children) observer.observe(cell);
    return () => observer.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stickySignature, visible.length, showFilters]);

  // 2段目の見出しは1段目の高さだけ下に留める
  useLayoutEffect(() => {
    const row = groupRowRef.current;
    if (!row) { setGroupHeight(0); return undefined; }
    const measure = () => setGroupHeight(Math.round(row.getBoundingClientRect().height));
    measure();
    if (typeof ResizeObserver === 'undefined') return undefined;
    const observer = new ResizeObserver(measure);
    observer.observe(row);
    return () => observer.disconnect();
  }, [groupCells]);

  function setColumnHidden(key, hidden) {
    const next = {...overrides, [key]: hidden};
    setOverrides(next);
    writeOverrides(persistKey, next);
  }

  function resetColumns() {
    setOverrides({});
    writeOverrides(persistKey, {});
  }

  function setFilter(key, value) {
    setFilters((previous) => {
      const next = {...previous};
      if (value === undefined) delete next[key]; else next[key] = value;
      return next;
    });
  }

  function clearFilters() {
    setFilters({});
    setQuery('');
  }

  function toggleSort(key) {
    setSort((previous) => {
      if (!previous || previous.key !== key) return {key, dir: 'asc'};
      if (previous.dir === 'asc') return {key, dir: 'desc'};
      return null;
    });
  }

  function toggleRow(row) {
    if (!renderDetail) return;
    const key = keyFor(row);
    setExpanded((previous) => {
      const next = new Set(previous);
      if (next.has(key)) next.delete(key); else next.add(key);
      return next;
    });
  }

  function activate(row, pos) {
    setActivePos(pos);
    toggleRow(row);
    onRowClick?.(row);
  }

  function focusPos(pos) {
    if (!dataRows.length) return;
    const target = Math.max(0, Math.min(pos, dataRows.length - 1));
    setActivePos(target);
    bodyRef.current?.querySelector(`tr[data-pos="${target}"]`)?.focus();
  }

  function onRowClick_(event, row, pos) {
    // セルの中の操作・入力（削除の確認のフォームを含む）は、注意文・余白を押しても行を開閉しない
    if (ignoresRowToggle(event.target, event.currentTarget)) return;
    activate(row, pos);
  }

  function onBodyKeyDown(event) {
    const tr = event.target.closest?.('tr[data-pos]');
    if (!tr || event.target !== tr) return;
    const pos = Number(tr.dataset.pos);
    const row = dataRows[pos];
    switch (event.key) {
      case 'ArrowDown': event.preventDefault(); focusPos(pos + 1); break;
      case 'ArrowUp': event.preventDefault(); focusPos(pos - 1); break;
      case 'Home': event.preventDefault(); focusPos(0); break;
      case 'End': event.preventDefault(); focusPos(dataRows.length - 1); break;
      case 'PageDown': event.preventDefault(); focusPos(pos + 20); break;
      case 'PageUp': event.preventDefault(); focusPos(pos - 20); break;
      case 'Enter': event.preventDefault(); if (row) activate(row, pos); break;
      case 'Escape':
        if (row && renderDetail && expanded.has(keyFor(row))) { event.preventDefault(); toggleRow(row); }
        break;
      default: break;
    }
  }

  function cellClass(column, extra = []) {
    const names = [...extra];
    if (column.sticky) names.push('dg-sticky');
    if (column.key === lastSticky) names.push('dg-sticky-edge');
    if (column.align === 'right' || (column.align !== 'left' && isNumericColumn(column))) names.push('num');
    if (column.wrap) names.push('dg-wrap');
    return names.join(' ') || undefined;
  }

  function cellStyle(column) {
    const style = {};
    if (column.sticky) style.left = offsets[column.key] ?? 0;
    if (Number.isFinite(column.width)) style.minWidth = `${column.width}ch`;
    return Object.keys(style).length ? style : undefined;
  }

  function cellContent(column, row) {
    if (typeof column.render === 'function') return column.render(row);
    const raw = valueOf(column, row);
    const text = rowCellText(column, row, {blankZero});
    if ((isBlank(raw) || raw === '') && text === UNKNOWN_TEXT) return <span className="dg-unknown">{UNKNOWN_TEXT}</span>;
    if (text === BLANK_ZERO_TEXT && isNumericColumn(column)) return <span className="dg-muted" aria-label="0">{BLANK_ZERO_TEXT}</span>;
    return text;
  }

  function sheets() {
    return [gridSheetSpec({
      columns: effective, rows: sorted, exportSpec, filters, query, showTotals, groupBy, subtotalLabel,
      totalLabel: exportSpec?.totalLabel ?? '合計',
    })];
  }

  if (!list.length) {
    return (
      <div className={`dg ${className}`.trim()}>
        {toolbar && <div className="dg-toolbar"><div className="dg-toolbar-custom">{toolbar}</div></div>}
        <p className="empty">{emptyText}</p>
      </div>
    );
  }

  let pos = -1;
  const totalRowLabel = `${totalLabel ?? '絞込範囲の合計'}（${int(filtered.length)}行）`;
  return (
    <div className={`dg ${className}`.trim()}>
      <div className="dg-toolbar">
        {toolbar && <div className="dg-toolbar-custom">{toolbar}</div>}
        <label className="dg-search">
          <span className="dg-vh">表内を検索</span>
          <input type="search" placeholder="表内を検索" value={query} onChange={(event) => setQuery(event.target.value)} />
        </label>
        <label className="dg-check">
          <input type="checkbox" checked={showFilters} onChange={(event) => setShowFilters(event.target.checked)} />
          列ごとに絞り込む
        </label>
        <details className="dg-columns">
          <summary>表示する列（{visible.length}/{effective.length}）</summary>
          <div className="dg-columns-list" role="group" aria-label="表示する列">
            {effective.map((column) => (
              <label key={column.key}>
                <input type="checkbox" checked={!column.hidden} disabled={!column.hidden && visible.length === 1}
                  onChange={(event) => setColumnHidden(column.key, !event.target.checked)} />
                {column.group ? `${column.group} ${column.label ?? column.key}` : column.label ?? column.key}
              </label>
            ))}
            <button type="button" className="secondary" onClick={resetColumns}>既定の列に戻す</button>
          </div>
        </details>
        <button type="button" className="secondary" onClick={clearFilters} disabled={!filtersActive}>絞込を解除</button>
        <span className="dg-count" aria-live="polite">{countText(list.length, filtered.length)}</span>
        {exportSpec && <ReportOutputBar sheets={sheets} name={exportSpec.name} period={exportSpec.period} title={exportSpec.title} formats={exportSpec.formats} />}
      </div>
      {limited.truncated && (
        <p className="dg-notice" role="status">
          表示は先頭{int(limited.rowsShown)}行までです（絞込後の{int(limited.rowsTotal)}行のうち）。合計と出力は{int(limited.rowsTotal)}行すべてが対象です。検索や列の絞込で行を減らしてください。
        </p>
      )}
      <div className="dg-scroll" style={{maxHeight}}>
        <table className={`dg-table${groupCells ? ' dg-has-groups' : ''}`} aria-label={ariaLabel ?? exportSpec?.title ?? exportSpec?.name}
          style={groupCells ? {'--dg-group-height': `${groupHeight}px`} : undefined}>
          <thead>
            {groupCells && (
              <tr ref={groupRowRef} className="dg-group-row">
                {groupCells.map((cell) => (
                  <th key={`g:${cell.first.key}`} scope={cell.label ? 'colgroup' : undefined} colSpan={cell.span > 1 ? cell.span : undefined}
                    className={[cell.label ? 'dg-group' : 'dg-group-empty', cell.span === 1 && cell.first.sticky ? 'dg-sticky' : '', cell.span === 1 && cell.first.key === lastSticky ? 'dg-sticky-edge' : ''].filter(Boolean).join(' ')}
                    style={cell.span === 1 && cell.first.sticky ? {left: offsets[cell.first.key] ?? 0} : undefined}>
                    {cell.label}
                  </th>
                ))}
              </tr>
            )}
            <tr ref={headRowRef}>
              {visible.map((column) => {
                const sorted_ = sort?.key === column.key ? sort.dir : null;
                const label = column.label ?? column.key;
                return (
                  <th key={column.key} scope="col" data-key={column.key} className={cellClass(column)} style={cellStyle(column)}
                    aria-sort={sorted_ === 'asc' ? 'ascending' : sorted_ === 'desc' ? 'descending' : undefined}>
                    {column.sortable === false
                      ? <span className="dg-head-label">{label}</span>
                      : (
                        <button type="button" className="dg-sort" onClick={() => toggleSort(column.key)}>
                          <span>{label}</span>
                          <span className="dg-sort-mark" aria-hidden="true">{sorted_ === 'asc' ? '▲' : sorted_ === 'desc' ? '▼' : ''}</span>
                        </button>
                      )}
                    {showFilters && (
                      <div className="dg-filter">
                        <FilterControl column={column} value={filters[column.key]} rows={list} onChange={(value) => setFilter(column.key, value)} />
                      </div>
                    )}
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody ref={bodyRef} onKeyDown={onBodyKeyDown}>
            {filtered.length === 0 && (
              <tr>
                <td colSpan={visible.length} className="dg-empty">
                  条件に合う行がありません。<button type="button" className="secondary" onClick={clearFilters}>絞込を解除</button>
                </td>
              </tr>
            )}
            {limited.items.map((item) => {
              if (item.type === 'subtotal') {
                return (
                  <tr key={`s:${String(item.group)}`} className="dg-subtotal">
                    {visible.map((column, index) => (
                      <td key={column.key} className={cellClass(column, item.totals[column.key]?.notSummable ? ['dg-not-summable'] : [])} style={cellStyle(column)}>
                        {index === 0 ? item.label : totalText(column, item.totals[column.key], {blankZero})}
                      </td>
                    ))}
                  </tr>
                );
              }
              pos += 1;
              const here = pos;
              const {row} = item;
              const key = keyFor(row);
              const open = Boolean(renderDetail) && expanded.has(key);
              return (
                <React.Fragment key={`r:${key}`}>
                  <tr data-pos={here} tabIndex={here === active ? 0 : -1} className={open ? 'dg-open' : undefined}
                    aria-expanded={renderDetail ? open : undefined}
                    onClick={(event) => onRowClick_(event, row, here)} onFocus={(event) => { if (event.target === event.currentTarget) setActivePos(here); }}>
                    {visible.map((column) => {
                      const n = isNumericColumn(column) ? toNumber(valueOf(column, row)) : null;
                      return (
                        <td key={column.key} className={cellClass(column, n !== null && n < 0 ? ['dg-neg'] : [])} style={cellStyle(column)}>
                          {cellContent(column, row)}
                        </td>
                      );
                    })}
                  </tr>
                  {open && (
                    <tr className="dg-detail">
                      <td colSpan={visible.length}><DetailFrame>{renderDetail(row)}</DetailFrame></td>
                    </tr>
                  )}
                </React.Fragment>
              );
            })}
          </tbody>
          {footerRow && filtered.length > 0 && (
            <tfoot>
              <tr>
                {visible.map((column, index) => {
                  const text = footerRow.values?.[column.key] ?? '';
                  return (
                    <td key={column.key} className={cellClass(column)} style={cellStyle(column)}>
                      {index === 0 ? <><span className="dg-total-label">{footerRow.label}</span>{text !== '' && <><br />{text}</>}</> : text}
                    </td>
                  );
                })}
              </tr>
            </tfoot>
          )}
          {!footerRow && hasTotals && filtered.length > 0 && (
            <tfoot>
              <tr>
                {visible.map((column, index) => {
                  const total = totals[column.key];
                  const text = totalText(column, total);
                  return (
                    <td key={column.key} className={cellClass(column, total?.notSummable ? ['dg-not-summable'] : [])} style={cellStyle(column)}>
                      {index === 0
                        ? (text ? <><span className="dg-total-label">{totalRowLabel}</span><br />{text}</> : <span className="dg-total-label">{totalRowLabel}</span>)
                        : text}
                    </td>
                  );
                })}
              </tr>
            </tfoot>
          )}
        </table>
      </div>
    </div>
  );
}

export default DataGrid;
