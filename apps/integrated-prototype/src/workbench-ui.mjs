import {optionsOf, labelOf, columnLabel} from './ui/labels.mjs';
import {int as formatInt, decimal as formatDecimal, month as formatMonth, dateTimeJst} from './ui/format.mjs';
import {parseYen, parseInteger, parseDate, parseMonth} from './ui/parse-input.mjs';
export const OPS={select:'列を選択',rename:'列名を変更',type:'型を変換',filter:'行を絞り込み',replace:'値を置換',split:'列を分割',concat:'列を結合',calculate:'計算列',sort:'並べ替え',join:'参照表を結合',append:'表を追加',dedupe:'重複を除く',group:'集計',pivot:'ピボット',unpivot:'ピボット解除'};
export const FALLBACK=[{key:'works',label:'作品マスタ'},{key:'products',label:'商品マスタ'},{key:'partners',label:'取引先マスタ'},{key:'sales_import',label:'売上取込（下書き）'}];
export const SALES_SAMPLE={report_key:'sample-2026-09',kind:'digital',partner_id:'',product_id:'',period_from:'2026-09-01',period_to:'2026-09-30',sales_period_from:'2026-09-01',sales_period_to:'2026-09-30',recognition_basis_id:'',sales_month:'2026-09',report_received_on:'2026-10-05',contract_start_on:'',license_start_on:'',broadcast_on:'',basis_reason:'月次販売報告',accounting_month:'2026-09',description:'',quantity:'1',amount_ex_tax:'0',tax_amount:'0',amount_inc_tax:'0',supersedes_id:''};
const lists=v=>Array.isArray(v)?v:String(v??'').split(',').map(x=>x.trim()).filter(Boolean);
export const step=operation=>({step_id:`step_${Date.now()}_${Math.random().toString(36).slice(2,7)}`,operation,parameters:{}});
export function editableStep(s){const p=structuredClone(s.parameters||{});if(s.operation==='rename'&&p.mapping){const pair=Object.entries(p.mapping)[0]||[];p.from=pair[0]||'';p.to=pair[1]||'';delete p.mapping}if(s.operation==='sort'&&Array.isArray(p.by)){p.column=p.by[0]?.column||'';p.direction=p.by[0]?.direction||'asc';delete p.by}if(s.operation==='group'&&Array.isArray(p.aggregates)){const a=p.aggregates[0]||{};p.aggregateColumn=a.column||'';p.aggregate=a.operation||'sum';p.into=a.into||'';delete p.aggregates}if(s.operation==='filter'&&p.valueType==null)p.valueType=typeof p.value==='number'?'number':typeof p.value==='boolean'?'boolean':'string';if(s.operation==='replace'&&p.valueType==null)p.valueType=typeof p.from==='number'?'number':typeof p.from==='boolean'?'boolean':'string';return {...s,parameters:p}}
const typed=(v,t)=>t==='number'?Number(v):t==='boolean'?String(v)==='true':v;
export function normalize(s){const p=s.parameters||{},o=s.operation,q={...p};if(['select','concat','calculate','dedupe','join'].includes(o))q.columns=lists(p.columns);if(o==='split')q.into=lists(p.into);if(o==='rename'&&!p.mapping){q.mapping=p.from?{[p.from]:p.to}:{};delete q.from;delete q.to}if(o==='sort'&&!Array.isArray(p.by)){q.by=[{column:p.column,direction:p.direction||'asc'}];delete q.column;delete q.direction}if(o==='group'){q.by=lists(p.by);if(!Array.isArray(p.aggregates)){q.aggregates=[{column:p.aggregateColumn||null,operation:p.aggregate||'sum',into:p.into}];delete q.aggregateColumn;delete q.aggregate;delete q.into}}if(o==='pivot')q.by=lists(p.by);if(o==='unpivot'){q.fixed=lists(p.fixed);q.columns=lists(p.columns)}if(o==='filter'){q.value=typed(p.value,p.valueType);delete q.valueType}if(o==='replace'){q.from=typed(p.from,p.valueType);q.to=typed(p.to,p.valueType);delete q.valueType}return {...s,parameters:q}}
export const show=v=>v==null?'':typeof v==='object'?JSON.stringify(v):String(v);
export function rectangle(a,b=a){if(!a||!b)return null;return {r1:Math.min(a.r,b.r),r2:Math.max(a.r,b.r),c1:Math.min(a.c,b.c),c2:Math.max(a.c,b.c)}}
export const inRectangle=(r,c,x)=>!!x&&r>=x.r1&&r<=x.r2&&c>=x.c1&&c<=x.c2;
export function tsvFor(rows,cols,rect){if(!rect)return '';return rows.slice(rect.r1,rect.r2+1).map(row=>cols.slice(rect.c1,rect.c2+1).map(c=>show(row[c.key]).replace(/\t/g,' ').replace(/[\r\n]+/g,' ')).join('\t')).join('\n')}
export const sourceKey=(r,i)=>String(r?._source?.key??r?.id??`row:${i}`);
export function pasteVisible(allRows,visibleKeys,cols,start,text){const matrix=String(text).replace(/\r/g,'').split('\n').filter((x,i,a)=>x!==''||i<a.length-1).map(x=>x.split('\t'));if(start.r+matrix.length>visibleKeys.length||matrix.some(x=>start.c+x.length>cols.length))throw new Error('貼り付け範囲が表示中の表を超えています');const out=structuredClone(allRows),byKey=new Map(out.map((r,i)=>[sourceKey(r,i),i]));for(let y=0;y<matrix.length;y++){const ai=byKey.get(visibleKeys[start.r+y]);if(ai==null)continue;for(let x=0;x<matrix[y].length;x++){const col=cols[start.c+x];if(col.editable!==false)out[ai][col.key]=matrix[y][x]}}return out}
export function updateVisible(allRows,visibleKey,key,value){return allRows.map((r,i)=>sourceKey(r,i)===visibleKey?{...r,[key]:value}:r)}
export function diffRows(base,now){const before=new Map(base.map((r,i)=>[sourceKey(r,i),r])),after=new Map(now.map((r,i)=>[sourceKey(r,i),r])),out=[];for(const [k,row] of after){const old=before.get(k);if(!old)out.push({key:k,kind:'追加',before:null,after:row});else if(JSON.stringify(old)!==JSON.stringify(row))out.push({key:k,kind:'変更',before:old,after:row})}for(const [k,row] of before)if(!after.has(k))out.push({key:k,kind:'削除',before:row,after:null});return out}
export function rowsFromSheet(sheet,headerRow=1,sourceHash=''){const values=sheet?.rows||[],i=Math.max(0,Number(headerRow||1)-1),headers=(values[i]||[]).map(x=>String(x??'').trim());if(!headers.length||headers.some(x=>!x))throw new Error('見出し行に空の列名があります');if(new Set(headers).size!==headers.length)throw new Error('見出し行に同じ列名があります');const out=[];for(let n=i+1;n<values.length;n++){const r=values[n]||[];if(!r.some(v=>v!==''&&v!=null))continue;if(r.slice(headers.length).some(v=>v!==''&&v!=null))throw new Error(`${n+1}行目に見出しのない値があります`);out.push(Object.fromEntries([...headers.map((h,j)=>[h,r[j]??'']),['_source',{key:`${sourceHash}:${sheet.name}:${n+1}`,sourceHash,sheet:sheet.name,row:n+1}]]))}return out}

// ─────────────────────────────────────────────────────────────────────────────
// 表編集（業務データ編集・売上データ編集）の操作。閲覧／編集の2モードのキー操作、貼付・消去・下への複写、
// セル単位の元に戻す、派生値（税込額・計上月）、検証エラーの行・セルへの対応付け、段階表示、出力を扱う。
// 画面は Workbench.jsx、試験は test/workbench-grid-keys.test.mjs。純関数のみ（ブラウザ・Node・Worker で同じ結果）。
// ─────────────────────────────────────────────────────────────────────────────

export const WB_PAGE_SIZE = 100;

// データセットの編集範囲（サーバー workbench.mjs の policies.scope と同じ）。メタデータに scope が無いときの既定。
export const DATASET_SCOPES = Object.freeze({works: 'project', products: 'org-admin', partners: 'org-admin', sales_import: 'finance'});

// 役割で編集できないデータセットは施錠し、理由を文字で示す（ui-guidelines §6）。
export function datasetAccess(dataset, role, scope = DATASET_SCOPES[dataset]) {
  if (!role) return {locked: false, reason: ''};
  if (scope === 'org-admin' && role !== 'admin') return {locked: true, reason: '管理者のみ編集できます'};
  if (role === 'production' && (scope === 'finance' || scope === 'project')) {
    return {locked: true, reason: scope === 'finance' ? '制作担当は売上データを編集できません' : '制作担当は作品マスタを編集できません'};
  }
  return {locked: false, reason: ''};
}

// ── 列の種類 ──────────────────────────────────────────────────────────────

// 計上基準マスタ（schema.sql の recognition_bases と同じ）。bootstrap の recognitionBases が無いときに使う。
export const RECOGNITION_BASES = Object.freeze([
  {id: 1, name: '販売月', field: 'sales_month'},
  {id: 2, name: '報告受領月', field: 'report_received_on'},
  {id: 3, name: '契約開始月', field: 'contract_start_on'},
  {id: 4, name: 'ライセンス利用開始月', field: 'license_start_on'},
  {id: 5, name: '放送月', field: 'broadcast_on'},
]);
const BASIS_FIELD = Object.freeze(Object.fromEntries(RECOGNITION_BASES.map((basis) => [basis.id, basis.field])));

// 売上取込で計算して読み取り専用にする列と、その理由（セルの説明に出す）。
export const SALES_DERIVED = Object.freeze({
  amount_inc_tax: '税抜額＋税額から計算します',
  accounting_month: '計上基準と対応する日付から計算します',
});

const SELECT_DOMAINS = Object.freeze({
  works: {format: 'workFormat'},
  products: {channel: 'productChannel'},
  partners: {kind: 'partnerKind'},
  sales_import: {kind: 'reportKind', digital_model: 'digitalModel', package_model: 'packageModel', theatrical_model: 'theatricalModel'},
});
const EXCLUDED_OPTIONS = Object.freeze({reportKind: ['publicity']});
const MONEY_KEY = /^(amount_ex_tax|tax_amount|amount_inc_tax)$|_yen$/;
export const NUMERIC_KINDS = Object.freeze(['yen', 'int', 'number']);

function lookupOptions(list = []) {
  return list.map((item) => {
    const name = item.name ?? item.title ?? item.label ?? '';
    const code = item.code ?? item.sku ?? '';
    return {value: String(item.id), label: code ? `${name}（${code}）` : String(name || `ID ${item.id}`), code: String(code), name: String(name)};
  });
}

// 表の列定義（{key,label,type,editable,lookup}）に、表示・入力の種類を足す。
// kind: yen|int|number|id|date|month|select|lookup|text。derived は計算列（読み取り専用）。
export function gridColumns(columns = [], {dataset, readOnly = false, lookups = {}, recognitionBases} = {}) {
  return columns.map((column) => {
    const key = column.key;
    const domain = SELECT_DOMAINS[dataset]?.[key];
    let kind = 'text';
    let options = null;
    if (column.lookup) {
      kind = 'lookup';
      options = lookupOptions(lookups[column.lookup] || []);
    } else if (dataset === 'sales_import' && key === 'recognition_basis_id') {
      kind = 'select';
      options = (recognitionBases?.length ? recognitionBases : RECOGNITION_BASES).map((basis) => ({value: String(basis.id), label: basis.name}));
    } else if (domain) {
      kind = 'select';
      options = optionsOf(domain).filter((option) => !(EXCLUDED_OPTIONS[domain] || []).includes(option.value));
    } else if (column.type === 'date') kind = 'date';
    else if (column.type === 'month') kind = 'month';
    else if (column.type === 'integer') kind = key === 'id' || key === 'version' || /_id$/.test(key) ? 'id' : MONEY_KEY.test(key) ? 'yen' : 'int';
    else if (/_ex_tax$/.test(key)) kind = 'number';
    const derived = dataset === 'sales_import' && Object.hasOwn(SALES_DERIVED, key);
    return {
      ...column,
      // 参照・計上基準は名称で選ぶので、見出しの「ID」を外す（取引先ID→取引先）
      label: (kind === 'lookup' || (kind === 'select' && /_id$/.test(key))) && /.ID$/.test(column.label || '') ? column.label.replace(/ID$/, '') : column.label || key,
      kind,
      options,
      derived,
      editable: !readOnly && column.editable !== false && !derived,
      // 計上月は計上基準が無い行（基準を使わない報告）では手で入力する
      editableWithoutBasis: !readOnly && column.editable !== false && derived && key === 'accounting_month',
      numeric: NUMERIC_KINDS.includes(kind),
    };
  });
}

// そのセルを編集できるか。計算列のうち計上月は、計上基準の無い行だけ入力できる。
export function cellEditable(column, row) {
  if (column.editable) return true;
  return Boolean(column.editableWithoutBasis && row && !BASIS_FIELD[Number(row.recognition_basis_id)]);
}

// ── 値の表示・入力 ─────────────────────────────────────────────────────────

const isBlankValue = (value) => value === null || value === undefined || (typeof value === 'string' && value.trim() === '');
const sameValue = (a, b) => String(a ?? '') === String(b ?? '');
const squashText = (value) => String(value ?? '').normalize('NFKC').trim();

function numberValue(value, {decimal = false} = {}) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (isBlankValue(value)) return null;
  if (decimal) {
    const n = Number(squashText(value).replace(/[,，、¥円]/g, ''));
    return Number.isFinite(n) ? n : null;
  }
  const parsed = parseYen(value);
  return parsed.ok ? parsed.value : null;
}

function optionFor(column, value) {
  return (column.options || []).find((option) => option.value === String(value)) || null;
}

// 閲覧モードのセルの文字。数値は桁区切り、日付は 2026/09/01、月は 2026年9月、選択肢は名称。
export function gridCellText(column, value) {
  if (isBlankValue(value)) return '';
  switch (column.kind) {
    case 'yen':
    case 'int': {
      const n = numberValue(value);
      return n === null ? show(value) : formatInt(n);
    }
    case 'number': {
      const n = numberValue(value, {decimal: true});
      return n === null ? show(value) : formatDecimal(n, {digits: 4});
    }
    case 'date':
      return /^\d{4}-\d{2}-\d{2}$/.test(String(value)) ? String(value).replaceAll('-', '/') : show(value);
    case 'month':
      return /^\d{4}-\d{2}$/.test(String(value)) ? formatMonth(value) : show(value);
    case 'select': {
      const option = optionFor(column, value);
      return option ? option.label : `未登録の値（${show(value)}）`;
    }
    case 'lookup': {
      const option = optionFor(column, value);
      return option ? option.label : `ID ${show(value)}（候補にありません）`;
    }
    default:
      return show(value);
  }
}

// 入力・貼付の値を列の種類に合わせて直す。全角・カンマ・¥・「2026/9/1」・選択肢の名称を吸収する。
// 直せないときは入力のまま残す（セルの注意と検証で理由を出す）。
export function normalizeCellInput(column, input) {
  if (isBlankValue(input)) return '';
  const text = String(input).replace(/\r?\n$/, '');
  switch (column.kind) {
    case 'yen':
    case 'int':
    case 'id': {
      const parsed = parseInteger(text);
      return parsed.ok && parsed.value !== null ? parsed.value : text;
    }
    case 'number': {
      const n = numberValue(text, {decimal: true});
      return n === null ? text : n;
    }
    case 'date': {
      const parsed = parseDate(text);
      return parsed.ok && parsed.value ? parsed.value : text;
    }
    case 'month': {
      const parsed = parseMonth(text);
      return parsed.ok && parsed.value ? parsed.value : text;
    }
    case 'select':
    case 'lookup': {
      const wanted = squashText(text).toLowerCase();
      const found = (column.options || []).find((option) => [option.value, option.label, option.code, option.name]
        .filter(Boolean).some((candidate) => squashText(candidate).toLowerCase() === wanted));
      return found ? found.value : text;
    }
    default:
      return text;
  }
}

// セル単位の注意（入力の目安）。空欄は注意しない。正本の判定はサーバーの「全件を検証」。
export function cellIssue(column, value, row = null) {
  if (column.derived && row) {
    const expected = deriveSalesValues(row)[column.key];
    if (!isBlankValue(expected) && !sameValue(expected, value)) {
      return `計算値（${gridCellText(column, expected)}）と一致しません。「税込額・計上月を計算し直す」で直せます`;
    }
  }
  if (isBlankValue(value)) return '';
  switch (column.kind) {
    case 'yen':
    case 'int':
    case 'id': {
      const parsed = parseInteger(value);
      return parsed.ok ? '' : parsed.error;
    }
    case 'number':
      return numberValue(value, {decimal: true}) === null ? '数値で入力してください' : '';
    case 'date': {
      const parsed = parseDate(value);
      if (!parsed.ok) return parsed.error;
      return parsed.value === String(value) ? '' : `日付の形を ${parsed.value} にそろえてください`;
    }
    case 'month': {
      const parsed = parseMonth(value);
      if (!parsed.ok) return parsed.error;
      return parsed.value === String(value) ? '' : `月の形を ${parsed.value} にそろえてください`;
    }
    case 'select':
      return optionFor(column, value) ? '' : '選択肢にない値です。一覧から選んでください';
    case 'lookup':
      return !column.options?.length || optionFor(column, value) ? '' : '候補にない値です。一覧から選んでください';
    default:
      return '';
  }
}

// ── 売上取込の派生値 ───────────────────────────────────────────────────────

// 税込額＝税抜額＋税額、計上月＝計上基準に対応する日付の月（販売月基準は販売月）。
// changedKeys を渡すと、その列に関係する派生値だけを計算し直す（ほかの列は元の値を保つ）。
export function deriveSalesValues(row, changedKeys = null) {
  const out = {...row};
  const changed = changedKeys ? new Set(changedKeys) : null;
  const touches = (keys) => !changed || keys.some((key) => changed.has(key));
  if (Object.hasOwn(out, 'amount_inc_tax') && touches(['amount_ex_tax', 'tax_amount'])) {
    const ex = numberValue(out.amount_ex_tax);
    const tax = numberValue(out.tax_amount);
    if (ex !== null && tax !== null) out.amount_inc_tax = ex + tax;
    else if (isBlankValue(out.amount_ex_tax) && isBlankValue(out.tax_amount)) out.amount_inc_tax = '';
  }
  const field = BASIS_FIELD[Number(out.recognition_basis_id)];
  if (field && Object.hasOwn(out, 'accounting_month') && touches(['recognition_basis_id', field])) {
    const source = out[field];
    const parsed = field === 'sales_month' ? parseMonth(source) : parseDate(source);
    if (parsed.ok && parsed.value) out.accounting_month = parsed.value.slice(0, 7);
    else if (isBlankValue(source)) out.accounting_month = '';
  }
  return out;
}

// 1つの報告の行は報告キー・取引先・期間・計上基準をそろえる。行を足すときは直前の行から写す。
const SHARED_SALES_KEYS = ['report_key', 'kind', 'partner_id', 'product_id', 'period_from', 'period_to', 'sales_period_from', 'sales_period_to',
  'recognition_basis_id', 'sales_month', 'report_received_on', 'contract_start_on', 'license_start_on', 'broadcast_on', 'basis_reason', 'supersedes_id'];

export function newSalesRow(previous, key) {
  const row = {...SALES_SAMPLE};
  if (previous) for (const field of SHARED_SALES_KEYS) if (Object.hasOwn(previous, field)) row[field] = previous[field];
  if (isBlankValue(row.recognition_basis_id)) row.recognition_basis_id = '1';
  return {...deriveSalesValues(row), _source: {key}};
}

// ── 行の識別・元に戻す（セル確定単位の差分） ────────────────────────────────

// 識別子（_source.key か id）が無い行に、位置に依存しない識別子を付ける。付けた行だけ新しいオブジェクトにする。
export function ensureRowKeys(rows = [], makeKey = (index) => `row:${index}`) {
  return rows.map((row, index) => (row?._source?.key != null || row?.id != null ? row : {...row, _source: {...(row?._source || {}), key: makeKey(index)}}));
}

export function rowNumbers(rows = []) {
  return new Map(rows.map((row, index) => [sourceKey(row, index), index + 1]));
}

function keyIndex(rows) {
  return new Map(rows.map((row, index) => [sourceKey(row, index), index]));
}

function assignField(row, field, value) {
  const next = {...row};
  if (value === undefined) delete next[field];
  else next[field] = value;
  return next;
}

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

function rectCells(rows, visibleKeys, columns, rect, pick) {
  const changes = [];
  let skipped = 0;
  if (!rect) return {changes, skipped};
  const byKey = new Map(rows.map((row, index) => [sourceKey(row, index), row]));
  for (let r = rect.r1; r <= Math.min(rect.r2, visibleKeys.length - 1); r++) {
    for (let c = rect.c1; c <= Math.min(rect.c2, columns.length - 1); c++) {
      const column = columns[c];
      if (!cellEditable(column, byKey.get(visibleKeys[r]))) {
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
export function clearCells(rows, visibleKeys, columns, rect, {derive} = {}) {
  const {changes, skipped} = rectCells(rows, visibleKeys, columns, rect, () => '');
  return {...setCells(rows, changes, {derive}), skipped};
}

// Ctrl+D: 範囲の先頭行を下の行へ写す。1行だけ選んでいるときは、すぐ上の行の値を写す（Excel と同じ）。
export function fillDown(rows, visibleKeys, columns, rect, {derive} = {}) {
  if (!rect) return {rows, edits: [], skipped: 0};
  const sourceRow = rect.r1 === rect.r2 ? rect.r1 - 1 : rect.r1;
  if (sourceRow < 0) return {rows, edits: [], skipped: 0};
  const byKey = new Map(rows.map((row, index) => [sourceKey(row, index), row]));
  const source = byKey.get(visibleKeys[sourceRow]) || {};
  const targets = {...rect, r1: rect.r1 === rect.r2 ? rect.r1 : rect.r1 + 1};
  const {changes, skipped} = rectCells(rows, visibleKeys, columns, targets, (r, c, column) => source[column.key] ?? '');
  return {...setCells(rows, changes, {derive}), skipped};
}

// 選択範囲の行を消す（売上取込だけ）。戻すときは元の位置へ戻る。
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

export function insertRow(rows, row, index = rows.length) {
  const at = Math.max(0, Math.min(rows.length, index));
  const edit = {type: 'insert', index: at, key: sourceKey(row, at), row};
  return {rows: applyEdits(rows, [edit]), edits: [edit]};
}

// Excel からコピーした範囲（タブ区切り）を行×列にする。末尾の改行は無視する。
export function parseClipboard(text) {
  const lines = String(text ?? '').replace(/\r\n?/g, '\n').split('\n');
  if (lines.length > 1 && lines.at(-1) === '') lines.pop();
  return lines.map((line) => line.split('\t'));
}

// 貼付。選択の左上から展開し、1セルだけコピーしたときは選択範囲全体へ同じ値を入れる。
// 表示行を超えるとき: allowAppend（売上取込）なら makeRow(i, 直前の行) で行を足し、そうでなければ何も変えずに理由を返す。
export function pasteCells(rows, visibleKeys, columns, selection, text, {allowAppend = false, makeRow, derive, appendHint} = {}) {
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
  let skipped = 0;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const column = columns[rect.c1 + x];
      const target = rect.r1 + y < visibleKeys.length ? byKey.get(visibleKeys[rect.r1 + y]) : null;
      if (target ? !cellEditable(column, target) : !column.editable) {
        skipped++;
        continue;
      }
      const value = normalizeCellInput(column, cell(y, x));
      const r = rect.r1 + y;
      if (r < visibleKeys.length) changes.push({key: visibleKeys[r], field: column.key, value});
      else appendedValues[r - visibleKeys.length][column.key] = value;
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
  return {ok: true, rows: out, edits, appended: overflow, skipped};
}

// ── キー操作（閲覧モード／編集モード） ─────────────────────────────────────

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

// ── 検証エラーの行・セルへの対応付け ────────────────────────────────────────

const ENGLISH_ERRORS = [
  [/^EST\/TVOD cannot carry view or contract metrics$/, () => 'EST・TVOD（購入・都度課金）の行には視聴数・契約の項目を入れられません'],
  [/^FLAT contract amount and both period dates must be supplied together$/, () => 'FLAT（定額）の契約額と契約期間の開始・終了はそろえて入力してください'],
  [/^FLAT\/MG cannot carry use metrics$/, () => 'FLAT・MGの行には利用実績（件数・視聴数）を入れられません'],
  [/^SVOD\/AVOD cannot carry sale count, unit price or contract amount$/, () => 'SVOD・AVODの行には販売件数・単価・契約額を入れられません'],
  [/^contract fields require FLAT$/, () => '契約額・契約期間はFLAT（定額）の行だけに入力できます'],
  [/^contract period is reversed$/, () => '契約期間の開始と終了が逆です'],
  [/^observation_unit, observation_scope and observation_basis are required$/, () => '観測単位・観測範囲・観測根拠をそろえて入力してください'],
  [/^observation metadata requires an observation count$/, () => '観測の情報を入れる行には納品数・稼働数・在庫数・返品数のいずれかが必要です'],
  [/^package observations require package report$/, () => '在庫などの観測値はビデオグラムの報告でだけ使えます'],
  [/^turns and rental price require rental model$/, () => '回転数・平均レンタル単価はレンタル方式の行でだけ使えます'],
  [/^inventory_as_of requires inventory_count$/, (m, label) => `${label('inventory_as_of')}を入れる行には${label('inventory_count')}も必要です`],
  [/^(\w+) is required and must be a recognized model$/, (m, label) => `${label(m[1])}を選択肢から選んでください`],
  [/^(\w+) is required with (\w+)$/, (m, label) => `${label(m[2])}を入れる行には${label(m[1])}も必要です`],
  [/^(\w+) is required for (\w+) detail$/, (m, label) => `${label(m[1])}を入力してください`],
  [/^(\w+) must be YYYY-MM-DD$/, (m, label) => `${label(m[1])}は日付（例: 2026-09-01）で入力してください`],
  [/^(\w+) must be a decimal$/, (m, label) => `${label(m[1])}は数値で入力してください`],
  [/^(\w+) must be a safe nonnegative integer$/, (m, label) => `${label(m[1])}は0以上の整数で入力してください`],
  [/^(\w+) is invalid for (\w+)$/, (m, label) => `${label(m[1])}はこの報告種別（${labelOf('reportKind', m[2])}）では使えません`],
  [/^(\w+) is too long$/, (m, label) => `${label(m[1])}が長すぎます`],
];

// 行エラーの文から対象の列を推し量る（サーバーの previewImport は列を返さないため）。
const MESSAGE_COLUMNS = [
  [/税込額/, 'amount_inc_tax'],
  [/選択した計上基準には(\w+)が必要/, 1],
  [/計上基準ID|計上基準マスタ/, 'recognition_basis_id'],
  [/計上根拠/, 'basis_reason'],
  [/販売月基準|sales_month/, 'sales_month'],
  [/計上月/, 'accounting_month'],
  [/取引先ID|取引先が/, 'partner_id'],
  [/商品が|商品ID/, 'product_id'],
  [/報告書キー|報告キー/, 'report_key'],
  [/販売期間/, 'sales_period_from'],
  [/期間が逆転/, 'period_to'],
  [/売上指標を持つ行には売上金額/, 'amount_ex_tax'],
  [/^(\w+) (?:is|must|requires)\b/, 1],
];
const VALUE_TYPES = [[/^整数ではありません: |^有効な整数ではありません: /, ['yen', 'int', 'id', 'select', 'lookup']], [/^日付はYYYY-MM-DD形式です: |^存在しない日付です: /, ['date']], [/^計上月はYYYY-MM形式です: /, ['month']]];

export function errorColumn(message, row, columns = []) {
  const text = String(message || '');
  const keys = new Set(columns.map((column) => column.key));
  for (const [pattern, target] of MESSAGE_COLUMNS) {
    const match = text.match(pattern);
    if (!match) continue;
    const key = typeof target === 'number' ? match[target] : target;
    if (keys.has(key)) return key;
  }
  for (const [pattern, kinds] of VALUE_TYPES) {
    if (!pattern.test(text) || !row) continue;
    const value = text.replace(pattern, '');
    const candidates = columns.filter((column) => sameValue(row[column.key], value));
    const typed = candidates.filter((column) => kinds.includes(column.kind));
    if (typed.length === 1) return typed[0].key;
    if (candidates.length === 1) return candidates[0].key;
  }
  return null;
}

// サーバーの行エラー文を日本語の1文にする（英語の例外文を主表示に出さない）。
export function describeRowError(message, {columns = [], column = null} = {}) {
  const text = String(message || '').trim();
  const labels = new Map(columns.map((item) => [item.key, item.label || item.key]));
  const label = (key) => labels.get(key) || columnLabel(key) || key;
  for (const [pattern, render] of ENGLISH_ERRORS) {
    const match = text.match(pattern);
    if (match) return render(match, label);
  }
  const valueError = text.match(/^(整数ではありません|有効な整数ではありません|日付はYYYY-MM-DD形式です|存在しない日付です|計上月はYYYY-MM形式です): ?(.*)$/);
  if (valueError) {
    const what = /整数/.test(valueError[1]) ? '整数で入力してください' : /存在しない/.test(valueError[1]) ? '存在する日付を入力してください' : /計上月/.test(valueError[1]) ? '月（例: 2026-09）で入力してください' : '日付（例: 2026-09-01）で入力してください';
    const shown = valueError[2] ? `（入力: ${valueError[2]}）` : '（空欄です）';
    return `${column ? `${label(column)}は` : ''}${what}${shown}`;
  }
  if (/^税込額が税抜額＋税額と一致しません/.test(text)) return '税込額が税抜額＋税額と一致しません。税抜額・税額を直すか「税込額・計上月を計算し直す」で直せます';
  const required = text.match(/^選択した計上基準には(\w+)が必要です$/);
  if (required) return `選択した計上基準には「${label(required[1])}」の入力が必要です`;
  return text.replace(/\bsales_month\b/g, label('sales_month')).replace(/\bcontract_start_on\b/g, label('contract_start_on'));
}

// 「全件を検証」の失敗本体（details）を表の行・セルに結び付ける。
// details の各要素: {rowNo, message, inputRow?, sourceRow?, sourceKey?} または {row, column, message}。
// rowNo は取込CSVの行（見出し＝1行目）。inputRow（下書きの何行目か）があればそれを使い、無いときは加工手順が無い場合に限って rowNo−1 行目とみなす。
export function mapRowErrors(details, {rows = [], columns = [], hasSteps = false} = {}) {
  const list = Array.isArray(details) ? details : Array.isArray(details?.errors) ? details.errors : details ? [details] : [];
  const keys = rows.map((row, index) => sourceKey(row, index));
  const items = [];
  const cells = new Map();
  const byRow = new Map();
  for (const raw of list) {
    const item = typeof raw === 'string' ? {message: raw} : raw && typeof raw === 'object' ? raw : {message: String(raw)};
    let index = null;
    if (Number.isInteger(item.inputRow) && item.inputRow >= 1) index = item.inputRow - 1;
    else if (item.sourceKey != null) index = keys.indexOf(String(item.sourceKey));
    else if (!hasSteps && Number(item.rowNo) >= 2) index = Number(item.rowNo) - 2;
    else if (Number.isInteger(item.row) && item.row >= 1) index = item.row - 1;
    if (index !== null && (index < 0 || index >= rows.length)) index = null;
    const row = index === null ? null : rows[index];
    const known = item.column && columns.some((column) => column.key === item.column) ? item.column : null;
    const column = known || errorColumn(item.message, row, columns);
    const message = describeRowError(item.message ?? item.error ?? '', {columns, column});
    const rowKey = row ? keys[index] : null;
    const entry = {
      rowKey,
      gridRow: index === null ? null : index + 1,
      sourceRow: Number.isInteger(row?._source?.row) ? row._source.row : Number.isInteger(item.sourceRow) ? item.sourceRow : null,
      column,
      columnLabel: column ? columns.find((c) => c.key === column)?.label || columnLabel(column) || column : null,
      message,
    };
    items.push(entry);
    if (rowKey) {
      if (!byRow.has(rowKey)) byRow.set(rowKey, []);
      byRow.get(rowKey).push(message);
      if (column) {
        const cellKey = `${rowKey}\u0000${column}`;
        cells.set(cellKey, cells.has(cellKey) ? `${cells.get(cellKey)}／${message}` : message);
      }
    }
  }
  items.sort((a, b) => (a.gridRow ?? 0) - (b.gridRow ?? 0));
  return {items, cells, byRow};
}

export const cellErrorKey = (rowKey, column) => `${rowKey}\u0000${column}`;

// ── 段階表示と次の操作 ──────────────────────────────────────────────────────

export const WORKFLOW_STAGES = Object.freeze([
  {id: 'load', label: '読込'},
  {id: 'edit', label: '加工'},
  {id: 'validate', label: '検証'},
  {id: 'submit', label: '承認申請'},
  {id: 'approve', label: '承認'},
  {id: 'apply', label: '反映'},
]);

// 今どの段階か、次に押すボタンは何か。next.action: save|validate|submit|approve|apply|restart|null。
export function workflowState({loaded = true, locked = false, readOnly = false, hasChanges = false, draft = null, dirty = false,
  validation = null, errorCount = 0, changeSet = null, application = null, role = null, reason = ''} = {}) {
  let current = 'load';
  let next = {action: null, label: '読み込み中です', enabled: false, reason: ''};
  const status = application || changeSet?.status === 'applied' ? 'applied' : changeSet?.status || null;
  if (!loaded) current = 'load';
  else if (locked) {
    current = 'load';
    next = {action: null, label: '編集できません', enabled: false, reason: '編集の権限がありません'};
  } else if (status === 'applied') {
    current = 'done';
    next = {action: 'restart', label: '新しい下書きで続けて編集', enabled: true, reason: ''};
  } else if (status === 'approved') {
    current = 'apply';
    next = {action: 'apply', label: 'DBへ反映する', enabled: true, reason: ''};
  } else if (status === 'submitted') {
    current = 'approve';
    next = role === 'admin'
      ? {action: 'approve', label: '承認する', enabled: true, reason: ''}
      : {action: null, label: '管理者の承認待ち', enabled: false, reason: '管理者が承認すると反映できます。待つ間も新しい下書きで続けて編集できます'};
  } else if (draft && !dirty && validation && !errorCount) {
    current = 'submit';
    next = {action: 'submit', label: '承認を申請する', enabled: Boolean(String(reason).trim()), reason: String(reason).trim() ? '' : '変更理由を入力してください'};
  } else if (draft && !dirty && errorCount) {
    current = 'validate';
    next = {action: null, label: 'エラーのセルを直す', enabled: false, reason: '赤いセルを直して下書きを保存し、もう一度検証してください'};
  } else if (draft && !dirty) {
    current = 'validate';
    next = {action: 'validate', label: '全件を検証する', enabled: true, reason: ''};
  } else {
    current = 'edit';
    next = hasChanges || draft
      ? {action: 'save', label: '下書きを保存する', enabled: true, reason: ''}
      : {action: null, label: '下書きを保存する', enabled: false, reason: '表を直すか、加工手順を足すと保存できます'};
  }
  if (readOnly && next.action && next.action !== 'restart') next = {...next, enabled: false, reason: 'プレビューでは保存・申請・反映はできません'};
  const order = WORKFLOW_STAGES.map((stage) => stage.id);
  const at = current === 'done' ? order.length : order.indexOf(current);
  const stages = WORKFLOW_STAGES.map((stage, index) => ({
    ...stage,
    state: index < at ? 'done' : index === at ? 'current' : 'todo',
  }));
  return {current, stages, next};
}

export const STAGE_STATE_TEXT = Object.freeze({done: '済', current: '現在', todo: '未'});

// ── 下書きの一覧の表示 ──────────────────────────────────────────────────────

// 「売上取込・「9月分の配信報告」・12行・承認申請中・2026/09/24 09:18」。IDは主表示に出さない。
export function draftLabel(draft, {datasetLabel = '', changeSet = null} = {}) {
  if (!draft) return '';
  const status = labelOf('changeSetStatus', changeSet?.status || draft.status || 'draft');
  const reason = changeSet?.reason ? `「${String(changeSet.reason).slice(0, 24)}${String(changeSet.reason).length > 24 ? '…' : ''}」` : '';
  const count = Number.isInteger(draft.rowCount) ? `${formatInt(draft.rowCount)}行` : '';
  const version = Number.isInteger(draft.revision) ? `第${draft.revision}版` : '';
  const when = draft.updatedAt ? dateTimeJst(draft.updatedAt) : '';
  return [datasetLabel, reason, count, version, status, when].filter(Boolean).join('・');
}

export function statusText(status) {
  return status ? labelOf('changeSetStatus', status) : '';
}

// ── 表示中の表の出力（Excel・CSV） ───────────────────────────────────────────

const EXPORT_TYPES = Object.freeze({yen: 'yen', int: 'int', number: 'number', id: 'id', date: 'date', month: 'month'});

// xlsx-report.mjs のシート定義。見出しは日本語。先頭に「行」（表の行番号・エラーの行番号と同じ）。
// 選択肢・参照は名称で出す。エラーがあれば「エラー内容」列を足す。
export function workbenchSheet({title = '表編集', columns = [], rows = [], allRows = rows, errors = null, conditions = [], dataAsOf} = {}) {
  const numbers = rowNumbers(allRows);
  const errorText = errors?.byRow || new Map();
  const specColumns = [
    {key: '__row', label: '行', type: 'int', total: 'none'},
    ...columns.map((column) => {
      const labelled = column.kind === 'select' || column.kind === 'lookup';
      return {
        key: column.key,
        label: column.label || column.key,
        type: labelled ? 'text' : EXPORT_TYPES[column.kind] || 'text',
        ...(labelled ? {exportValue: (row) => (isBlankValue(row[column.key]) ? '' : gridCellText(column, row[column.key]))} : {}),
      };
    }),
  ];
  const hasErrors = errorText.size > 0;
  if (hasErrors) specColumns.push({key: '__error', label: 'エラー内容', type: 'text'});
  const outRows = rows.map((row, index) => {
    const key = sourceKey(row, index);
    return {...row, __row: numbers.get(key) ?? index + 1, ...(hasErrors ? {__error: (errorText.get(key) || []).join('／')} : {})};
  });
  const yenColumns = columns.filter((column) => column.kind === 'yen');
  const totals = yenColumns.length && rows.length
    ? [{label: `合計（${formatInt(rows.length)}行）`, values: Object.fromEntries(yenColumns.map((column) => [column.key, rows.reduce((sum, row) => sum + (numberValue(row[column.key]) ?? 0), 0)]))}]
    : [];
  return {name: title, title, conditions, dataAsOf, columns: specColumns, rows: outRows, totals, freezeCols: 2};
}

// 未保存の変更の件数（未保存保護に登録する数）。行の差分＋加工手順の変更。
export function unsavedCount(savedRows = [], rows = [], stepsChanged = false) {
  return diffRows(savedRows, rows).length + (stepsChanged ? 1 : 0);
}
