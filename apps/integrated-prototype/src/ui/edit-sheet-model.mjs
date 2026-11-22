// 編集できる表（EditSheet.jsx と業務データ編集の表）の論理。React に依存しない純関数だけを置く。
// 前半は業務データ編集（workbench-ui.mjs が再 export する）と共通の操作: 選択・キー操作・貼付・消去・下への複写・元に戻す。
// 後半は EditSheet の列の型（文字・整数・円・率・日付・選択・候補）、表示と読み取り、絞り込み・並べ替え・合計・選んだ範囲の集計。
// 表は行を書き換えず、変えたセルを edits（{type:'cell',key,field,before,after} | {type:'insert'|'delete',index,key,row}）で返す。
// 保存の仕方（版・取消の行を足す）は呼び出し側が決める。試験: test/edit-sheet-model.test.mjs・test/workbench-grid-keys.test.mjs
import {parseYen, parseInteger, parseDate} from './parse-input.mjs';
import {int as formatInt, rate as formatRate} from './format.mjs';
import {filterRows, sortRows, totalsFor, NULL_FILTER} from './grid-model.mjs';
import {matchEntities, normalizeForMatch} from './entity-match.mjs';

// ── 共通: 値の文字・選択の範囲・行の識別 ────────────────────────────────────

export const show = (v) => (v == null ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v));

export function rectangle(a, b = a) {
  if (!a || !b) return null;
  return {r1: Math.min(a.r, b.r), r2: Math.max(a.r, b.r), c1: Math.min(a.c, b.c), c2: Math.max(a.c, b.c)};
}

export const inRectangle = (r, c, x) => !!x && r >= x.r1 && r <= x.r2 && c >= x.c1 && c <= x.c2;

// 選択範囲をタブ区切りにする（Excel・Google スプレッドシートへ貼れる形）。text を渡すとセルの文字をそれで作る。
export function tsvFor(rows, cols, rect, text = (column, row) => show(row?.[column.key])) {
  if (!rect) return '';
  return rows.slice(rect.r1, rect.r2 + 1)
    .map((row) => cols.slice(rect.c1, rect.c2 + 1).map((c) => text(c, row).replace(/\t/g, ' ').replace(/[\r\n]+/g, ' ')).join('\t'))
    .join('\n');
}

export const sourceKey = (r, i) => String(r?._source?.key ?? r?.id ?? `row:${i}`);

// 識別子（_source.key か id）が無い行に、位置に依存しない識別子を付ける。付けた行だけ新しいオブジェクトにする。
export function ensureRowKeys(rows = [], makeKey = (index) => `row:${index}`) {
  return rows.map((row, index) => (row?._source?.key != null || row?.id != null ? row : {...row, _source: {...(row?._source || {}), key: makeKey(index)}}));
}

export function rowNumbers(rows = []) {
  return new Map(rows.map((row, index) => [sourceKey(row, index), index + 1]));
}

const sameValue = (a, b) => String(a ?? '') === String(b ?? '');

function keyIndex(rows) {
  return new Map(rows.map((row, index) => [sourceKey(row, index), index]));
}

function assignField(row, field, value) {
  const next = {...row};
  if (value === undefined) delete next[field];
  else next[field] = value;
  return next;
}

// ── 共通: 変更（edits）の適用と、元に戻す ──────────────────────────────────

// edits: [{type:'cell',key,field,before,after} | {type:'insert',index,key,row} | {type:'delete',index,key,row}]
export function applyEdits(rows, edits = [], direction = 'forward') {
  let out = rows.slice();
  let index = null;
  const forward = direction === 'forward';
  for (const edit of forward ? edits : [...edits].reverse()) {
    if (edit.type === 'cell') {
      if (!index) index = keyIndex(out);
      const at = index.get(edit.key);
      if (at !== undefined) out[at] = assignField(out[at], edit.field, forward ? edit.after : edit.before);
      continue;
    }
    index = null;
    const adding = (edit.type === 'insert') === forward;
    if (adding) out.splice(Math.max(0, Math.min(out.length, edit.index)), 0, edit.row);
    else {
      const at = out.findIndex((row, i) => sourceKey(row, i) === edit.key);
      if (at >= 0) out.splice(at, 1);
    }
  }
  return out;
}

// 1つ戻すための変更。前へ当てると applyEdits(rows, edits, 'backward') と同じ結果になる（呼び出し側は前へ当てるだけでよい）。
export function invertEdits(edits = []) {
  return [...edits].reverse().map((edit) => {
    if (edit.type === 'cell') return {...edit, before: edit.after, after: edit.before};
    if (edit.type === 'insert') return {...edit, type: 'delete'};
    if (edit.type === 'delete') return {...edit, type: 'insert'};
    return edit;
  });
}

// changes: [{key, field, value}]。同じ値は記録しない。derive(row, 変わった列) で派生値も計算し直して記録する。
export function setCells(rows, changes = [], {derive} = {}) {
  const out = rows.slice();
  const index = keyIndex(out);
  const edits = [];
  const touched = new Map();
  for (const {key, field, value} of changes) {
    const at = index.get(key);
    if (at === undefined || sameValue(out[at][field], value)) continue;
    edits.push({type: 'cell', key, field, before: out[at][field], after: value});
    out[at] = {...out[at], [field]: value};
    if (!touched.has(key)) touched.set(key, new Set());
    touched.get(key).add(field);
  }
  if (derive) {
    for (const [key, fields] of touched) {
      const at = index.get(key);
      const next = derive(out[at], [...fields]);
      for (const field of Object.keys(next)) {
        if (!sameValue(out[at][field], next[field])) edits.push({type: 'cell', key, field, before: out[at][field], after: next[field]});
      }
      out[at] = next;
    }
  }
  return {rows: out, edits};
}

export function insertRow(rows, row, index = rows.length) {
  const at = Math.max(0, Math.min(rows.length, index));
  const edit = {type: 'insert', index: at, key: sourceKey(row, at), row};
  return {rows: applyEdits(rows, [edit]), edits: [edit]};
}

// 選択範囲の行を消す。戻すときは元の位置へ戻る。
export function deleteRowsByKeys(rows, keys = []) {
  const wanted = new Set(keys);
  const edits = [];
  let out = rows.slice();
  for (let at = 0; at < out.length;) {
    const key = sourceKey(out[at], at);
    if (wanted.has(key)) {
      edits.push({type: 'delete', index: at, key, row: out[at]});
      out = [...out.slice(0, at), ...out.slice(at + 1)];
    } else at++;
  }
  return {rows: out, edits};
}

// ── 共通: 範囲の操作（消す・下へ写す・貼る） ────────────────────────────────

// canEdit(column, row) はセルを直せるか。既定は列の editable。read(column, 文字) は貼る値の読み取りで {ok, value} を返す。
const defaultCanEdit = (column) => Boolean(column?.editable);
const defaultRead = (column, text) => ({ok: true, value: text});

function rectCells(rows, visibleKeys, columns, rect, pick, canEdit = defaultCanEdit) {
  const changes = [];
  let skipped = 0;
  if (!rect) return {changes, skipped};
  const byKey = new Map(rows.map((row, index) => [sourceKey(row, index), row]));
  for (let r = rect.r1; r <= Math.min(rect.r2, visibleKeys.length - 1); r++) {
    for (let c = rect.c1; c <= Math.min(rect.c2, columns.length - 1); c++) {
      const column = columns[c];
      if (!canEdit(column, byKey.get(visibleKeys[r]))) {
        skipped++;
        continue;
      }
      const value = pick(r, c, column);
      if (value !== undefined) changes.push({key: visibleKeys[r], field: column.key, value});
    }
  }
  return {changes, skipped};
}

// Delete: 選択範囲の編集できるセルを空にする。
export function clearCells(rows, visibleKeys, columns, rect, {derive, canEdit} = {}) {
  const {changes, skipped} = rectCells(rows, visibleKeys, columns, rect, () => '', canEdit);
  return {...setCells(rows, changes, {derive}), skipped};
}

// Ctrl+D: 範囲の先頭行を下の行へ写す。1行だけ選んでいるときは、すぐ上の行の値を写す（Excel と同じ）。
export function fillDown(rows, visibleKeys, columns, rect, {derive, canEdit} = {}) {
  if (!rect) return {rows, edits: [], skipped: 0};
  const sourceRow = rect.r1 === rect.r2 ? rect.r1 - 1 : rect.r1;
  if (sourceRow < 0) return {rows, edits: [], skipped: 0};
  const byKey = new Map(rows.map((row, index) => [sourceKey(row, index), row]));
  const source = byKey.get(visibleKeys[sourceRow]) || {};
  const targets = {...rect, r1: rect.r1 === rect.r2 ? rect.r1 : rect.r1 + 1};
  const {changes, skipped} = rectCells(rows, visibleKeys, columns, targets, (r, c, column) => source[column.key] ?? '', canEdit);
  return {...setCells(rows, changes, {derive}), skipped};
}

// Excel からコピーした範囲（タブ区切り）を行×列にする。末尾の改行は無視する。
export function parseClipboard(text) {
  const lines = String(text ?? '').replace(/\r\n?/g, '\n').split('\n');
  if (lines.length > 1 && lines.at(-1) === '') lines.pop();
  return lines.map((line) => line.split('\t'));
}

// 貼付。選択の左上から展開し、1セルだけコピーしたときは選択範囲全体へ同じ値を入れる。
// 表示行を超えるとき: allowAppend なら makeRow(i, 直前の行) で行を足し、そうでなければ何も変えずに理由を返す。
// read が {ok:false} を返したセルは入れずに数える（rejected・rejectedCells）。read の3つ目の引数は貼る先の行（足す行は null）。
export function pasteCells(rows, visibleKeys, columns, selection, text, {allowAppend = false, makeRow, derive, appendHint, canEdit = defaultCanEdit, read = defaultRead} = {}) {
  const matrix = parseClipboard(text);
  const rect = rectangle(selection?.anchor, selection?.focus) || {r1: 0, r2: 0, c1: 0, c2: 0};
  const single = matrix.length === 1 && matrix[0].length === 1;
  const height = single ? rect.r2 - rect.r1 + 1 : matrix.length;
  const width = single ? rect.c2 - rect.c1 + 1 : Math.max(...matrix.map((line) => line.length));
  const cell = (y, x) => (single ? matrix[0][0] : matrix[y]?.[x] ?? '');
  const overColumns = rect.c1 + width - columns.length;
  if (overColumns > 0) {
    return {ok: false, reason: 'columns', rows, edits: [], message: `コピーした範囲が表の右端を${overColumns}列超えています。貼り付ける位置を左へずらしてください`};
  }
  const overflow = Math.max(0, rect.r1 + height - visibleKeys.length);
  if (overflow > 0 && (!allowAppend || typeof makeRow !== 'function')) {
    return {
      ok: false, reason: 'rows', overflow, rows, edits: [],
      message: `コピーした範囲が表示中の行を${overflow}行超えています。${appendHint || '行の追加はExcel一括登録で行ってください'}`,
    };
  }
  const changes = [];
  const appendedValues = Array.from({length: overflow}, () => ({}));
  const byKey = new Map(rows.map((row, index) => [sourceKey(row, index), row]));
  const rejectedCells = [];
  let skipped = 0;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const column = columns[rect.c1 + x];
      const target = rect.r1 + y < visibleKeys.length ? byKey.get(visibleKeys[rect.r1 + y]) : null;
      if (target ? !canEdit(column, target) : !canEdit(column, null)) {
        skipped++;
        continue;
      }
      const r = rect.r1 + y;
      const parsed = read(column, cell(y, x), target);
      if (!parsed.ok) {
        rejectedCells.push({r, c: rect.c1 + x});
        continue;
      }
      if (r < visibleKeys.length) changes.push({key: visibleKeys[r], field: column.key, value: parsed.value});
      else appendedValues[r - visibleKeys.length][column.key] = parsed.value;
    }
  }
  const result = setCells(rows, changes, {derive});
  let out = result.rows;
  const edits = [...result.edits];
  appendedValues.forEach((values, i) => {
    const template = makeRow(i, out.at(-1) || null);
    const merged = {...template, ...values};
    const row = derive ? derive(merged, Object.keys(values)) : merged;
    const inserted = insertRow(out, row);
    out = inserted.rows;
    edits.push(...inserted.edits);
  });
  return {ok: true, rows: out, edits, appended: overflow, skipped, rejected: rejectedCells.length, rejectedCells};
}

// ── 共通: キー操作と選択 ─────────────────────────────────────────────────────

// 閲覧モード: 矢印・Tab で移動、Enter・F2・文字入力で編集、Delete で範囲を空に、Ctrl+Z/Y/D/C/V。
// 編集モード: Esc で取消、Enter で確定して下へ（Shift で上へ）、Tab で確定して右へ。矢印はセル内のカーソル移動。
export function gridKeyAction(event, {editing = false, readOnly = false} = {}) {
  if (!event || event.isComposing || event.keyCode === 229) return {type: 'none'};
  const key = event.key || '';
  const lower = key.toLowerCase();
  const command = event.ctrlKey || event.metaKey;
  if (editing) {
    if (key === 'Escape') return {type: 'cancel'};
    if (key === 'Enter' && !event.altKey && !command) return {type: 'commit', dr: event.shiftKey ? -1 : 1, dc: 0};
    if (key === 'Tab') return {type: 'commit', dr: 0, dc: event.shiftKey ? -1 : 1};
    return {type: 'none'};
  }
  const blocked = {type: 'readonly'};
  if (command && !event.altKey) {
    if (lower === 'c') return {type: 'copy'};
    if (lower === 'v') return readOnly ? blocked : {type: 'paste'};
    if (lower === 'z') return readOnly ? blocked : {type: event.shiftKey ? 'redo' : 'undo'};
    if (lower === 'y') return readOnly ? blocked : {type: 'redo'};
    if (lower === 'd') return readOnly ? blocked : {type: 'fillDown'};
    if (lower === 'a') return {type: 'selectAll'};
    if (key === 'Home') return {type: 'moveTo', r: 0, c: 0, extend: Boolean(event.shiftKey)};
    if (key === 'End') return {type: 'moveTo', r: 'last', c: 'last', extend: Boolean(event.shiftKey)};
    return {type: 'none'};
  }
  switch (key) {
    case 'ArrowUp': return {type: 'move', dr: -1, dc: 0, extend: Boolean(event.shiftKey)};
    case 'ArrowDown': return {type: 'move', dr: 1, dc: 0, extend: Boolean(event.shiftKey)};
    case 'ArrowLeft': return {type: 'move', dr: 0, dc: -1, extend: Boolean(event.shiftKey)};
    case 'ArrowRight': return {type: 'move', dr: 0, dc: 1, extend: Boolean(event.shiftKey)};
    case 'Tab': return {type: 'move', dr: 0, dc: event.shiftKey ? -1 : 1, extend: false};
    case 'Home': return {type: 'moveTo', c: 0, extend: Boolean(event.shiftKey)};
    case 'End': return {type: 'moveTo', c: 'last', extend: Boolean(event.shiftKey)};
    case 'Enter':
    case 'F2': return readOnly ? blocked : {type: 'edit', keep: true};
    case 'Delete':
    case 'Backspace': return readOnly ? blocked : {type: 'clear'};
    case 'Escape': return {type: 'collapse'};
    default: break;
  }
  if (key.length === 1 && !event.altKey) return readOnly ? blocked : {type: 'edit', keep: false, text: key};
  return {type: 'none'};
}

const clamp = (value, low, high) => Math.max(low, Math.min(high, value));

// 選択を動かす。extend（Shift）なら起点を残して範囲を広げる。rows・cols は表示中の行数・列数。
export function moveSelection(selection, action, {rows, cols}) {
  if (!rows || !cols) return selection || null;
  if (action.type === 'selectAll') return {anchor: {r: 0, c: 0}, focus: {r: rows - 1, c: cols - 1}};
  const focus = selection?.focus || {r: 0, c: 0};
  let r = focus.r;
  let c = focus.c;
  if (action.type === 'move' || action.type === 'commit') {
    r += action.dr || 0;
    c += action.dc || 0;
  } else if (action.type === 'moveTo') {
    if (action.r !== undefined) r = action.r === 'last' ? rows - 1 : action.r;
    if (action.c !== undefined) c = action.c === 'last' ? cols - 1 : action.c;
  } else if (action.type === 'collapse') {
    return {anchor: {...focus}, focus: {...focus}};
  }
  r = clamp(r, 0, rows - 1);
  c = clamp(c, 0, cols - 1);
  const extend = action.extend && selection?.anchor;
  return {anchor: extend ? selection.anchor : {r, c}, focus: {r, c}};
}

// 選択範囲に含まれる行の識別子（「選択行を削除」用）。
export function selectedRowKeys(visibleKeys, selection) {
  const rect = rectangle(selection?.anchor, selection?.focus);
  if (!rect) return [];
  return visibleKeys.slice(rect.r1, Math.min(rect.r2, visibleKeys.length - 1) + 1);
}

// ── EditSheet: 列の型 ───────────────────────────────────────────────────────

// 列: {key, label, type, options, readOnly, width, total, value(row)（計算列。読むだけ）, text(row)（表示だけ）,
//   badge(row)（札にする。'stop'|'weak'|'plain'）, year（月/日だけの入力に補う年）, onCreate（候補に無い名前を登録する。呼び出し側）}
// type: text | int | yen | rate（読むだけ） | date | choice（決まった選択肢） | lookup（ID で結ぶ。候補から選ぶ）
export const SHEET_TYPES = Object.freeze(['text', 'int', 'yen', 'rate', 'date', 'choice', 'lookup']);
const NUMERIC = new Set(['int', 'yen', 'rate']);
const WIDTH = {text: 160, int: 96, yen: 120, rate: 96, date: 110, choice: 130, lookup: 180};

function optionOf(option) {
  if (option && typeof option === 'object') {
    const value = String(option.value ?? option.id ?? '');
    return {...option, value, label: String(option.label ?? option.name ?? value)};
  }
  return {value: String(option ?? ''), label: String(option ?? '')};
}

// 列の定義をそろえる。readOnly（表全体）を渡すと全部の列を読むだけにする。
export function sheetColumns(columns = [], {readOnly = false} = {}) {
  return columns.map((column) => {
    const type = SHEET_TYPES.includes(column.type) ? column.type : 'text';
    const editable = !readOnly && !column.readOnly && typeof column.value !== 'function' && type !== 'rate';
    return {
      ...column,
      type,
      label: column.label ?? column.key,
      width: column.width ?? WIDTH[type],
      options: type === 'choice' || type === 'lookup' ? (column.options || []).map(optionOf) : null,
      editable,
      numeric: NUMERIC.has(type),
      total: column.total ?? (type === 'yen' ? 'sum' : 'none'),
    };
  });
}

const isBlank = (value) => value === null || value === undefined || (typeof value === 'string' && value.trim() === '');

export function cellValue(column, row) {
  if (!row) return undefined;
  return typeof column.value === 'function' ? column.value(row) : row[column.key];
}

function findOption(column, value) {
  return (column.options || []).find((option) => option.value === String(value)) || null;
}

function dateText(value, year) {
  const match = String(value ?? '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return show(value);
  const monthDay = `${Number(match[2])}/${match[3]}`;
  return year && Number(match[1]) === Number(year) ? monthDay : `${match[1]}/${monthDay}`;
}

// セルに出す文字。数値は桁区切り（単位は見出しに書く）、日付は 11/19（列の年と違えば 2025/11/19）、選択肢と候補は名前。
export function sheetCellText(column, row) {
  if (!row) return '';
  if (typeof column.text === 'function') return String(column.text(row) ?? '');
  const value = cellValue(column, row);
  if (isBlank(value)) return '';
  switch (column.type) {
    case 'int':
    case 'yen':
      return typeof value === 'number' ? formatInt(value) : show(value);
    case 'rate':
      return typeof value === 'number' && Number.isFinite(value) ? formatRate(value) : show(value);
    case 'date':
      return dateText(value, column.year);
    case 'choice':
    case 'lookup':
      return findOption(column, value)?.label ?? show(value);
    default:
      return show(value);
  }
}

// 直し始めたときに入力欄へ入れる文字（数値は桁区切りを外す）。
export function sheetEditText(column, row) {
  const value = cellValue(column, row);
  if (isBlank(value)) return '';
  if ((column.type === 'int' || column.type === 'yen') && typeof value === 'number') return String(value);
  return sheetCellText(column, row);
}

const optionItems = (column) => (column.options || []).map((option) => ({...option, id: option.value, code: option.code ?? '', label: option.label}));

// 候補を選ぶ: 名前・コード・値が同じなら1つに決まる。前方一致で1つに絞れるときもそれに決める。
function readOption(column, text) {
  const wanted = normalizeForMatch(text);
  const options = column.options || [];
  const exact = options.find((option) => [option.value, option.label, option.code, option.name].filter(Boolean)
    .some((candidate) => normalizeForMatch(candidate) === wanted));
  if (exact) return {ok: true, value: exact.value};
  const prefix = matchEntities(optionItems(column), text, {limit: Infinity}).filter((item) => item.match === 'prefix');
  if (prefix.length === 1) return {ok: true, value: prefix[0].value};
  return {ok: false, error: '候補にありません'};
}

const MONTH_DAY = /^(\d{1,2})[/\-.月](\d{1,2})日?$/;

// 入力・貼付の文字を列の型の値にする。合わないときは {ok:false, error}（表には入れない）。空欄は空にする。
export function parseCell(column, input) {
  const text = String(input ?? '').replace(/\r?\n$/, '');
  if (isBlank(text)) return {ok: true, value: column.type === 'int' || column.type === 'yen' ? null : ''};
  switch (column.type) {
    case 'int': {
      const parsed = parseInteger(text);
      return parsed.ok ? {ok: true, value: parsed.value} : {ok: false, error: parsed.error};
    }
    case 'yen': {
      const parsed = parseYen(text);
      return parsed.ok ? {ok: true, value: parsed.value} : {ok: false, error: parsed.error};
    }
    case 'date': {
      const squashed = text.normalize('NFKC').replace(/\s+/g, '');
      const monthDay = column.year ? squashed.match(MONTH_DAY) : null;
      const parsed = parseDate(monthDay ? `${column.year}/${monthDay[1]}/${monthDay[2]}` : squashed);
      return parsed.ok ? {ok: true, value: parsed.value} : {ok: false, error: parsed.error};
    }
    case 'choice':
    case 'lookup':
      return readOption(column, text);
    case 'rate':
      return {ok: false, error: '読むだけの列です'};
    default:
      return {ok: true, value: text.trim()};
  }
}

// 入っている値が型に合わないときの理由（赤の細い枠にする）。空欄と合う値は ''。
export function cellProblem(column, row) {
  if (!row || typeof column.value === 'function') return '';
  const value = row[column.key];
  if (isBlank(value)) return '';
  switch (column.type) {
    case 'int':
    case 'yen':
      return Number.isInteger(value) ? '' : '数ではありません';
    case 'date':
      return /^\d{4}-\d{2}-\d{2}$/.test(String(value)) && parseDate(value).ok ? '' : '日付ではありません';
    case 'choice':
    case 'lookup':
      return findOption(column, value) ? '' : '候補にありません';
    default:
      return '';
  }
}

// 候補の一覧。打った文字で絞り、候補に同じ名前が無く登録の道（onCreate）があれば create にその名前を返す。
export function sheetCandidates(column, query = '') {
  const items = matchEntities(optionItems(column), query, {limit: Infinity});
  const options = items.map((item) => findOption(column, item.value)).filter(Boolean);
  const name = String(query ?? '').trim();
  const known = name && (column.options || []).some((option) => normalizeForMatch(option.label) === normalizeForMatch(name) || normalizeForMatch(option.code) === normalizeForMatch(name));
  return {options, create: typeof column.onCreate === 'function' && name && !known ? name : null};
}

// ── EditSheet: 1つのセルを直す（最後の空の行に打つと行を足す） ─────────────────

// at.r が表示行の数と同じなら、makeRow(直前の行) で行を足してから入れる。
export function writeCell(rows, visibleKeys, columns, at, value, {makeRow} = {}) {
  const column = columns[at.c];
  if (!column) return {rows, edits: []};
  if (at.r < visibleKeys.length) return setCells(rows, [{key: visibleKeys[at.r], field: column.key, value}]);
  if (typeof makeRow !== 'function') return {rows, edits: []};
  return insertRow(rows, {...makeRow(rows.at(-1) || null), [column.key]: value});
}

// ── EditSheet: 見えている行（絞り込み・並べ替え） ───────────────────────────

const filterSpec = (column) => ({key: column.key, type: 'text', value: (row) => sheetCellText(column, row)});
const sortSpec = (column) => (column.numeric
  ? {key: column.key, type: 'int', value: (row) => cellValue(column, row)}
  : {key: column.key, type: 'text', value: (row) => (column.type === 'date' ? cellValue(column, row) : sheetCellText(column, row))});

// filters: {列の key: 見せる文字の配列（'' は空欄）}。sort: {key, dir:'asc'|'desc'}。行の順は変えず、見せる順だけを返す。
export function sheetView(rows = [], columns = [], {filters = {}, sort = null} = {}) {
  const active = Object.fromEntries(Object.entries(filters || {}).filter(([key, list]) => Array.isArray(list) && columns.some((c) => c.key === key))
    .map(([key, list]) => [key, list.map((text) => (text === '' ? NULL_FILTER : text))]));
  const keyed = rows.map((row, index) => ({...row, __sheetKey: sourceKey(row, index)}));
  const filtered = Object.keys(active).length ? filterRows(keyed, columns.map(filterSpec), active).filter((row) => {
    // 何も選ばない絞り込みは、行を1つも見せない（grid-model は空の配列を「絞らない」と読むため、ここで落とす）
    return Object.values(active).every((list) => list.length > 0);
  }) : keyed;
  const sorted = sort?.key ? sortRows(filtered, columns.map(sortSpec), sort) : filtered;
  return {
    rows: sorted.map(({__sheetKey, ...row}) => row),
    keys: sorted.map((row) => row.__sheetKey),
  };
}

// 絞り込みの一覧に出す文字（重複なし。並べ替えと同じ順。空欄は ''）。
export function filterChoices(rows = [], column) {
  const sorted = sortRows(rows, [sortSpec(column)], {key: column.key, dir: 'asc'});
  return [...new Set(sorted.map((row) => sheetCellText(column, row)))];
}

// 見出しの絞り込みを、選んだ文字の配列から決める。全部を選んでいれば絞らない（null）。
export function nextFilter(choices = [], picked = []) {
  const set = new Set(picked);
  return choices.every((text) => set.has(text)) ? null : choices.filter((text) => set.has(text));
}

// ── EditSheet: 選択を呼び出し側へ渡す・行番号で選ぶ・行ごとの候補・戻すの履歴 ─────

// 呼び出し側へ渡す選択（onSelect）。range は2セル以上を選んでいるか、rowKeys は範囲に入っている見えている行の鍵
// （最後の空の行は入れない）、visibleKeys は絞り込み・並べ替えの後に見えている行の鍵（見えている順）
export function selectionInfo(rect, visibleKeys = []) {
  const keys = [...visibleKeys];
  if (!rect) return {range: false, rowKeys: [], visibleKeys: keys};
  return {range: rect.r1 !== rect.r2 || rect.c1 !== rect.c2, rowKeys: selectedRowKeys(keys, {anchor: {r: rect.r1, c: rect.c1}, focus: {r: rect.r2, c: rect.c2}}), visibleKeys: keys};
}

// 行番号を押したときの選択。extend（Shift）なら、いまの起点の行から押した行まで、全部の列を選ぶ
export function rowHeadSelection(selection, r, cols, {extend = false} = {}) {
  const last = Math.max(0, cols - 1);
  const from = extend && selection?.anchor ? selection.anchor.r : r;
  return {anchor: {r: from, c: 0}, focus: {r, c: last}};
}

// 行ごとの候補。列が candidatesFor(row) を持てば、その行の候補だけで選ぶ・読む（表示の名前は列の options から引く）。
// 行が無い（最後の空の行・足す行）か candidatesFor が無ければ、列の options のまま
export function columnForRow(column, row) {
  if (!row || typeof column?.candidatesFor !== 'function') return column;
  return {...column, options: (column.candidatesFor(row) || []).map(optionOf)};
}

// 戻すの履歴。呼び出し側が渡す historyEpoch が変わったら空にする（保存した変更を戻す道を残さない）
export const historyAfterEpoch = (history, previous, epoch) => (Object.is(previous, epoch) ? history : []);

// ── EditSheet: 合計の行と、選んだ範囲の集計 ─────────────────────────────────

// 見えている行の合計（{key: 数}）。合計する列（total:'sum'。円の既定）だけ。
export function sheetTotals(rows = [], columns = []) {
  const specs = columns.filter((column) => column.total === 'sum')
    .map((column) => ({key: column.key, type: column.type === 'yen' ? 'yen' : 'int', total: 'sum', value: (row) => cellValue(column, row)}));
  return Object.fromEntries(Object.entries(totalsFor(rows, specs)).map(([key, total]) => [key, total.value]));
}

// 選んだ範囲の集計。数の列のセルから合計・件数・平均、全体で空でないセルの数。yen は円の列を含むか。
export function rangeStats(rows = [], columns = [], rect) {
  const out = {cells: 0, filled: 0, count: 0, sum: 0, average: null, yen: false};
  if (!rect) return out;
  for (let r = rect.r1; r <= rect.r2; r++) {
    const row = rows[r];
    if (!row) continue;
    for (let c = rect.c1; c <= Math.min(rect.c2, columns.length - 1); c++) {
      const column = columns[c];
      out.cells += 1;
      if (sheetCellText(column, row) !== '') out.filled += 1;
      const value = cellValue(column, row);
      if ((column.type === 'int' || column.type === 'yen') && typeof value === 'number' && Number.isFinite(value)) {
        out.count += 1;
        out.sum += value;
        if (column.type === 'yen') out.yen = true;
      }
    }
  }
  if (out.count) out.average = out.sum / out.count;
  return out;
}

// ── EditSheet: 集計のシート（明細から作る。読むだけ） ────────────────────────

// keyOf(row) ごとに件数と measures の和を数える。share に measures の名前を渡すと、その和の構成比（0〜1）を足す。
// 並びは最初に現れた順。例: summarize(明細, (r) => r.payee, {measures: {amount: (r) => r.amount}, share: 'amount'})
export function summarize(rows = [], keyOf, {measures = {}, share = null} = {}) {
  const groups = new Map();
  for (const row of rows) {
    const key = keyOf(row) ?? '';
    if (!groups.has(key)) groups.set(key, {key, count: 0, ...Object.fromEntries(Object.keys(measures).map((name) => [name, 0]))});
    const group = groups.get(key);
    group.count += 1;
    for (const [name, measure] of Object.entries(measures)) {
      const n = Number(measure(row));
      if (Number.isFinite(n)) group[name] += n;
    }
  }
  const list = [...groups.values()];
  if (share) {
    const total = list.reduce((sum, group) => sum + group[share], 0);
    for (const group of list) group.share = total ? group[share] / total : 0;
  }
  return list;
}
