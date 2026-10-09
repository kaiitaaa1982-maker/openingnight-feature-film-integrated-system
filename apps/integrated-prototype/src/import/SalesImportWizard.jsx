// 売上報告の取込ウィザード（原本取り込み）。受領した報告（Excel・CSV・文字のあるPDF）を原本ごと保存し、
// 1 ファイルを選ぶ → 2 見出しを確かめる → 3 列を対応づける → 4 作品・商品に割り当てる → 5 表で確かめる → 6 登録結果 の一本道で共通売上へ登録する。
// 原本は作品から切り離して受け取り（/api/sales-import/files）、登録の前なら理由を書いて作品を付け替えられる。
// 1つのファイルを商品コードの列（商品マスタ→作品配賦）か作品コードの列で作品ごとに分け、作品ごとに確かめて順に登録する。
// 論理は wizard-model.mjs・source-partition.mjs・header-detect.mjs・column-synonyms.mjs（node で試験）にあり、この部品は状態と描画だけを持つ。
import React, {useCallback, useEffect, useMemo, useRef, useState} from 'react';
import {useShell} from '../shell/context.mjs';
import {DataGrid} from '../ui/DataGrid.jsx';
import {Notice} from '../ui/Notice.jsx';
import {FormField} from '../ui/FormField.jsx';
import {EntityPicker} from '../ui/EntityPicker.jsx';
import {Tabs} from '../ui/Tabs.jsx';
import {toEntityItems} from '../ui/entity-match.mjs';
import {labelOf} from '../ui/labels.mjs';
import {yen, int, month as monthText, dateJst, dateTimeJst} from '../ui/format.mjs';
import {downloadXlsx} from '../xlsx.mjs';
import {suggestSalesImportFormats} from '../import-format.mjs';
import {RawReportWorkflow} from '../Workflow.jsx';
import {detectEncoding, ENCODING_LABELS} from './text-decode.mjs';
import {detectHeaderRow, detectTotalRows, headerProblems, sheetPreview, CONFIDENCE_LABELS, PREVIEW_ROWS} from './header-detect.mjs';
import {TARGET_LABELS} from './column-synonyms.mjs';
import {
  FIELD_SPECS, MODE_LABELS, CHECK_TYPES, BASIS_FIELDS, blankField, basisDateTarget, autoReportKey, buildDefinition, defaultFields, guessPeriod,
  sameDefinition, validateChecks, describeCheck, buildReviewRows, reviewTotals, reportLevelErrors, sourceColumnTotals, compareControls,
  overlapDecisionProblem, failedRowsSheet, defaultExclusionReason, selectionRows, friendlyMessage,
  draftBinding, mappingFitsBinding, partitionSelection, partitionAmountText, productChoicesFor, refitProductField, restrictedFileMessage, pendingListTitle,
} from './wizard-model.mjs';
import {RESOLVED_PRODUCT_COLUMN, bindingText, commitProgress, guessSplitColumn, sameBinding, selectionTable} from './source-partition.mjs';
import '../reports/reports.css';
import './import-wizard.css';

const STEPS = ['ファイルを選ぶ', '見出しを確かめる', '列を対応づける', '作品・商品に割り当てる', '表で確かめる', '登録結果'];
const LAST_STEP = STEPS.length;
const KINDS = ['digital', 'package', 'theatrical', 'broadcast', 'other'];
const ASSIGN_MODES = Object.freeze([
  {value: 'single_work', label: '1つの作品', hint: '報告の全行を、選んだ1つの作品の売上にします'},
  {value: 'by_product', label: '商品コードの列で作品ごとに分ける', hint: '行ごとの商品コードを作品商品マスタの商品と照らし、配賦先の作品ごとに報告を分けます'},
  {value: 'by_work_column', label: '作品コードの列で作品ごとに分ける', hint: '行ごとの作品コードを作品マスタと照らし、作品ごとに報告を分けます'},
]);
const PARTNER_KIND_DEFAULT = {platform: 'digital', retailer: 'package', cinema: 'theatrical'};
const MAX_FILE_BYTES = 6_000_000;
const UNSAVED_ID = 'sales-import-wizard';
const EMPTY_DECISION = Object.freeze({mode: '', reason: '', targetId: ''});
const EMPTY_TAB = Object.freeze({preview: null, previewError: null, overlaps: null, decision: EMPTY_DECISION});

function bytesToBase64(bytes) {
  let binary = '';
  for (let index = 0; index < bytes.length; index += 0x8000) binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  return btoa(binary);
}

async function sha256Hex(bytes) {
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

const fileSizeText = (bytes) => (bytes >= 1_000_000 ? `${(bytes / 1_000_000).toFixed(1)}MB` : `${Math.max(1, Math.round(bytes / 1000))}KB`);
const kindLabel = (kind) => labelOf('reportKind', kind);
const periodText = (from, to) => (from && to ? `${dateJst(from)}〜${dateJst(to)}` : '未確認');
const workName = (item) => item?.workTitle || (item?.restricted ? '権限のない作品' : '作品未確認');

// 保存済みの選択（GET /sales-import/files/:id）→ 画面の選択の形
function selectionFromSaved(saved) {
  if (!saved) return null;
  const rows = Array.isArray(saved.excluded) ? saved.excluded : [];
  return {
    selectionId: saved.id, versionNo: saved.versionNo, sheetName: saved.sheetName, headerRow: saved.headerRow,
    headers: selectionTable(saved.canonicalCsv, saved.sourceRowNumbers).headers, canonicalCsv: saved.canonicalCsv, canonicalHash: saved.canonicalHash,
    sourceRowNumbers: saved.sourceRowNumbers, excluded: {rows, count: rows.length}, mappingVersionId: null,
  };
}

function StepBar({step, onJump}) {
  return (
    <nav className="iw-steps" aria-label="取込の手順">
      <ol>
        {STEPS.map((label, index) => {
          const n = index + 1;
          const state = n < step ? 'done' : n === step ? 'current' : 'todo';
          const jump = n < step && step < LAST_STEP;
          return (
            <li key={label} className={`is-${state}`} aria-current={n === step ? 'step' : undefined}>
              {jump
                ? <button type="button" className="iw-step-link" title="この手順に戻る" onClick={() => onJump(n)}><span className="iw-step-no" aria-hidden="true">✓</span><span className="iw-step-text">{label}</span><span className="iw-vh">（済み。押すとこの手順に戻ります）</span></button>
                : <span className="iw-step-label"><span className="iw-step-no" aria-hidden="true">{state === 'done' ? '✓' : n}</span><span className="iw-step-text">{label}</span>{state === 'done' && <span className="iw-vh">（済み）</span>}</span>}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}

function ActionBar({children}) {
  return <div className="iw-actions" role="group" aria-label="手順の操作">{children}</div>;
}

// ---------- 手順1 ----------
function PreviousImports({context, partnerName}) {
  if (!context?.recent) return null;
  if (!context.recent.length) return <p className="rp-muted">{partnerName ? `${partnerName}からの取込はまだありません。` : ''}</p>;
  const last = context.recent[0];
  return (
    <div className="iw-previous">
      <p><strong>前回の取込</strong>: {dateTimeJst(last.createdAt)}・{int(last.lineCount)}件・税抜 {yen(last.totals.amountExTax)}・税込 {yen(last.totals.amountIncTax)}（{kindLabel(last.kind)}、対象期間 {periodText(last.periodFrom, last.periodTo)}、作品「{last.workTitle}」）</p>
      {context.recent.length > 1 && (
        <details>
          <summary>最近の取込（{context.recent.length}件）</summary>
          <table className="iw-mini">
            <thead><tr><th scope="col">登録日時</th><th scope="col">報告の種類</th><th scope="col">対象期間</th><th scope="col" className="num">件数</th><th scope="col" className="num">税抜</th><th scope="col">状態</th></tr></thead>
            <tbody>{context.recent.map((row) => (
              <tr key={row.id}><td>{dateTimeJst(row.createdAt)}</td><td>{kindLabel(row.kind)}</td><td>{periodText(row.periodFrom, row.periodTo)}</td><td className="num">{int(row.lineCount)}</td><td className="num">{int(row.totals.amountExTax)}</td><td>{labelOf('reportStatus', row.status)}</td></tr>
            ))}</tbody>
          </table>
        </details>
      )}
    </div>
  );
}

// 同じファイルが別の作品に割り当て済みのとき（登録前）: 理由を書いてこの作品へ付け替えるか、元の作品のまま続ける
function RebindOffer({offer, onChange, onRebind, onKeep, onCancel, busy, readOnly}) {
  const toTitle = offer.toTitle || '選んだ作品';
  return (
    <div className="iw-offer" role="group" aria-label="作品の付け替え">
      <Notice tone="warn" title="このファイルは別の作品の原本として受け取り済みです"
        message={`作品「${offer.fromTitle || '権限のない作品'}」の原本として${offer.legacy ? '旧方式で保存' : '受け取り'}済みで、まだ登録していません。作品「${toTitle}」の報告なら、理由を書いて付け替えられます（付け替えの記録は残ります）。`} />
      <FormField type="textarea" label="付け替える理由" required rows={2} maxLength={500} value={offer.reason} disabled={busy || readOnly}
        placeholder={`例: 作品「${toTitle}」の報告を、誤って作品「${offer.fromTitle || '別の作品'}」で受け取ったため`} onChange={(value) => onChange({...offer, reason: value})} />
      <div className="on-form-actions">
        <button type="button" disabled={busy || readOnly || !offer.reason.trim()} onClick={onRebind}>作品「{toTitle}」に付け替えて続ける</button>
        {offer.fromTitle && <button type="button" className="secondary" disabled={busy || readOnly} onClick={onKeep}>作品「{offer.fromTitle}」のまま続ける</button>}
        <button type="button" className="text" disabled={busy} onClick={onCancel}>やめる</button>
      </div>
    </div>
  );
}

// ---------- 手順2 ----------
function HeaderTable({sheet, headerRow, totalRows, onChoose, disabled}) {
  const preview = useMemo(() => sheetPreview(sheet?.rows || [], {count: PREVIEW_ROWS}), [sheet]);
  const totals = new Set(totalRows.map((item) => item.row));
  return (
    <div className="iw-sheet" role="region" aria-label="原本の先頭の行" tabIndex={0}>
      <table>
        <thead>
          <tr><th scope="col" className="iw-rowno">行</th>{preview.columns.map((letter) => <th key={letter} scope="col">{letter}</th>)}</tr>
        </thead>
        <tbody>
          {preview.rows.map((row) => {
            const state = row.row === headerRow ? 'is-header' : headerRow && row.row < headerRow ? 'is-above' : totals.has(row.row) ? 'is-total' : '';
            return (
              <tr key={row.row} className={state} onClick={() => !disabled && onChoose(row.row)}>
                <th scope="row" className="iw-rowno">
                  <label>
                    <input type="radio" name="iw-header-row" checked={row.row === headerRow} disabled={disabled} onChange={() => onChoose(row.row)} aria-label={`${row.row}行目を見出しにする`} />
                    <span>{row.row}</span>
                  </label>
                  {row.row === headerRow && <span className="iw-tag">見出し</span>}
                  {totals.has(row.row) && <span className="iw-tag is-warn">合計？</span>}
                </th>
                {row.cells.map((cell, index) => <td key={index} title={cell}>{cell}</td>)}
              </tr>
            );
          })}
        </tbody>
      </table>
      <p className="rp-muted">全{int(preview.total)}行中、先頭{int(preview.shown)}行を表示しています。{disabled ? '' : '行を押すとその行を見出しにします。'}</p>
    </div>
  );
}

// ---------- 手順3 ----------
function selectValue(spec, field) {
  if (!field?.mode) return '';
  if (spec.key === 'product_id') return field.mode === 'literal' ? (field.value ? `p:${field.value}` : '') : field.mode === 'resolved' ? 'mode:resolved' : 'mode:none';
  if (spec.key === 'recognition_basis_id') return field.mode === 'literal' ? (field.value ? `b:${field.value}` : '') : 'mode:none';
  return field.mode === 'source' ? `col:${field.source}` : `mode:${field.mode}`;
}

function modeLabel(spec, mode) {
  if (spec.key === 'report_key' && mode === 'literal') return '手で入力する';
  if (spec.key === 'report_key' && mode === 'auto') return '自動で付ける';
  if (spec.input === 'date' && mode === 'literal') return '日付を入力する';
  if (spec.input === 'month' && mode === 'literal') return '年月を入力する';
  if (spec.key === 'basis_date' && mode === 'literal') return '日付・年月を入力する';
  if (spec.key === 'description' && mode === 'none') return '使わない（「報告明細」と記録）';
  if (spec.key === 'description' && mode === 'literal') return '同じ文を入れる';
  if (spec.key === 'product_id' && mode === 'none') return '使わない（作品に直接計上）';
  if (spec.key === 'recognition_basis_id' && mode === 'none') return '使わない（計上月を入れる）';
  return MODE_LABELS[mode] || mode;
}

function OperandPicker({field, headers, onChange, label, disabled}) {
  const operands = field.operands?.length ? field.operands : ['', ''];
  const sign = field.mode === 'add' ? '＋' : field.mode === 'subtract' ? '−' : '×';
  const set = (index, value) => onChange({...field, operands: operands.map((item, i) => (i === index ? value : item))});
  return (
    <div className="iw-operands">
      {operands.map((value, index) => (
        <React.Fragment key={index}>
          {index > 0 && <span className="iw-sign" aria-hidden="true">{sign}</span>}
          <select aria-label={`${label}の計算に使う${index + 1}つ目の列`} value={value} disabled={disabled} onChange={(event) => set(index, event.target.value)}>
            <option value="">列を選ぶ</option>
            {headers.map((header) => <option key={header} value={header}>{header}</option>)}
          </select>
        </React.Fragment>
      ))}
      {field.mode !== 'subtract' && operands.length < 8 && <button type="button" className="text" disabled={disabled} onClick={() => onChange({...field, operands: [...operands, '']})}>列を足す</button>}
      {field.mode !== 'subtract' && operands.length > 2 && <button type="button" className="text" disabled={disabled} onClick={() => onChange({...field, operands: operands.slice(0, -1)})}>最後の列を外す</button>}
    </div>
  );
}

function MappingRow({spec, field, note, error, headers, onChange, products, bases, basisTarget, correction, autoKey, disabled, resolvedAllowed}) {
  const label = spec.key === 'basis_date' && basisTarget ? TARGET_LABELS[basisTarget] : spec.label;
  const id = `iw-map-${spec.key}`;
  const value = selectValue(spec, field);
  const columns = spec.columns !== false && spec.modes.includes('source');
  function choose(next) {
    if (next.startsWith('col:')) onChange({...field, mode: 'source', source: next.slice(4)});
    else if (next.startsWith('p:') || next.startsWith('b:')) onChange({...field, mode: 'literal', value: next.slice(2)});
    else if (next.startsWith('mode:')) {
      const mode = next.slice(5);
      onChange({...field, mode, operands: ['add', 'subtract', 'multiply'].includes(mode) && !(field.operands || []).some(Boolean) ? ['', ''] : field.operands});
    } else onChange({...field, mode: ''});
  }
  const otherModes = spec.modes.filter((mode) => mode !== 'source'
    && !((spec.key === 'product_id' || spec.key === 'recognition_basis_id') && mode === 'literal')
    && !(spec.key === 'product_id' && mode === 'resolved' && !resolvedAllowed));
  let control;
  if (spec.key === 'report_key' && correction) {
    control = <p className="iw-fixed">訂正する元の報告の番号「{correction.reportKey}」を使います</p>;
  } else if (spec.key === 'basis_reason') {
    control = <input id={id} type="text" maxLength={1000} value={field.value || ''} disabled={disabled} placeholder="例: 月次の報告を受け取った月で計上する" onChange={(event) => onChange({...field, mode: 'literal', value: event.target.value})} aria-invalid={error ? true : undefined} />;
  } else {
    control = (
      <select id={id} value={value} disabled={disabled} onChange={(event) => choose(event.target.value)} aria-invalid={error ? true : undefined}>
        <option value="">選んでください</option>
        {spec.key === 'product_id' && <optgroup label="商品">{products.map((product) => <option key={product.id} value={`p:${product.id}`}>{product.name}（{product.sku}）</option>)}</optgroup>}
        {spec.key === 'recognition_basis_id' && <optgroup label="計上基準">{bases.map((basis) => <option key={basis.id} value={`b:${basis.id}`}>{basis.name}</option>)}</optgroup>}
        {columns && <optgroup label="元の列">{headers.map((header) => <option key={header} value={`col:${header}`}>{header}</option>)}</optgroup>}
        <optgroup label="ほかの方法">
          {otherModes.map((mode) => <option key={mode} value={`mode:${mode}`}>{modeLabel(spec, mode)}</option>)}
        </optgroup>
      </select>
    );
  }
  let extra = null;
  if (!correction || spec.key !== 'report_key') {
    if (field.mode === 'auto') extra = <p className="iw-fixed">{autoKey}</p>;
    else if (field.mode === 'literal' && ['text', 'date', 'month', 'basis-date'].includes(spec.input) && spec.key !== 'basis_reason') {
      const type = spec.input === 'basis-date' ? (basisTarget === 'sales_month' ? 'month' : 'date') : spec.input === 'text' ? 'text' : spec.input;
      extra = <input type={type} aria-label={`${label}の値`} value={field.value || ''} disabled={disabled} maxLength={type === 'text' ? 200 : undefined} onChange={(event) => onChange({...field, value: event.target.value})} />;
    } else if (['add', 'subtract', 'multiply'].includes(field.mode)) extra = <OperandPicker field={field} headers={headers} onChange={onChange} label={label} disabled={disabled} />;
  }
  return (
    <tr className={error ? 'is-invalid' : undefined}>
      <th scope="row">
        <label htmlFor={id}>{label}</label>
        {spec.required && <span className="on-req">必須</span>}
      </th>
      <td>
        <div className="iw-map-control">{control}{extra}</div>
        {error && <p className="on-field-error">{error}</p>}
      </td>
      <td className="iw-note">{note || ''}</td>
    </tr>
  );
}

function ChecksEditor({checks, headers, onChange, disabled}) {
  const update = (index, patch) => onChange(checks.map((check, i) => (i === index ? {...check, ...patch} : check)));
  const columnSelect = (index, key, value, label) => (
    <select aria-label={`検算${index + 1}の${label}`} value={value || ''} disabled={disabled} onChange={(event) => update(index, {[key]: event.target.value})}>
      <option value="">{label}</option>
      {headers.map((header) => <option key={header} value={header}>{header}</option>)}
    </select>
  );
  return (
    <div className="iw-checks">
      {checks.length === 0 && <p className="rp-muted">原本の列どうしで確かめたいこと（例: 総額 − 手数料 ＝ 正味）があれば足します。合わない行は手順5でエラーになります。</p>}
      {checks.map((check, index) => (
        <div className="iw-check" key={index}>
          <select aria-label={`検算${index + 1}の種類`} value={check.type} disabled={disabled} onChange={(event) => update(index, {type: event.target.value})}>
            {Object.entries(CHECK_TYPES).map(([type, label]) => <option key={type} value={type}>{label}</option>)}
          </select>
          {check.type === 'required'
            ? columnSelect(index, 'column', check.column, '空欄にしない列')
            : <>{columnSelect(index, 'left', check.left, 'A')}<span className="iw-sign" aria-hidden="true">{check.type === 'difference' ? '−' : '×'}</span>{columnSelect(index, 'right', check.right, 'B')}<span className="iw-sign" aria-hidden="true">＝</span>{columnSelect(index, 'result', check.result, 'C')}</>}
          <button type="button" className="text" disabled={disabled} onClick={() => onChange(checks.filter((_, i) => i !== index))}>外す</button>
        </div>
      ))}
      <button type="button" className="secondary" disabled={disabled || checks.length >= 20} onClick={() => onChange([...checks, {type: 'difference', left: '', right: '', result: ''}])}>検算を足す</button>
    </div>
  );
}

// ---------- 手順4 ----------
function assignmentColumns() {
  return [
    {key: 'work', label: '作品', type: 'text', sticky: true},
    {key: 'products', label: '商品（コード）と行数', type: 'text', wrap: true},
    {key: 'row_count', label: '行数', type: 'int', total: 'sum'},
    {key: 'amount', label: '税抜合計', type: 'text'},
    {key: 'state', label: '状態', type: 'text'},
  ];
}

// ---------- 手順5 ----------
function cellWithIssue(row, key, text) {
  const issue = row.issues.find((item) => item.target === key);
  if (!issue) return text;
  return <span className="iw-bad-cell" title={issue.message}>{text}<small>{issue.message}</small></span>;
}

function reviewColumns() {
  const number = (value) => (value == null ? '未確認' : Number(value) === 0 ? '—' : int(value));
  const amount = (key, label) => ({key, label, type: 'yen', total: 'none', render: (row) => cellWithIssue(row, key, number(row[key]))});
  return [
    {key: 'source_row', label: '原本の行', type: 'int', total: 'none', sticky: true},
    {key: 'status_label', label: '状態', type: 'text', render: (row) => <span className={`iw-status is-${row.status}`}>{row.status_label}</span>},
    {key: 'partner_name', label: '取引先', type: 'text', render: (row) => cellWithIssue(row, 'partner_id', row.partner_name)},
    {key: 'product_name', label: '商品', type: 'text', render: (row) => cellWithIssue(row, 'product_id', row.product_name)},
    {key: 'description', label: '明細名', type: 'text', wrap: true},
    {key: 'quantity', label: '数量', type: 'int', total: 'none', render: (row) => cellWithIssue(row, 'quantity', row.quantity == null ? '—' : int(row.quantity))},
    amount('amount_ex_tax', '税抜'),
    amount('tax_amount', '税額'),
    amount('amount_inc_tax', '税込'),
    {key: 'accounting_month', label: '計上月', type: 'text', render: (row) => cellWithIssue(row, 'accounting_month', row.accounting_month ? monthText(row.accounting_month) : '未確認')},
    {key: 'sales_period', label: '販売期間', type: 'text', render: (row) => cellWithIssue(row, 'sales_period_from', row.sales_period)},
    {key: 'reasons', label: 'エラー・注意の理由', type: 'text', wrap: true},
  ];
}

// ---------- 手順6 ----------
function ResultDetail({result, navigate, sourceName}) {
  return (
    <>
      {result.auditWarning && <Notice tone="warn" message={result.auditWarning} />}
      <div className="rp-tiles">
        <div><span>登録した明細</span><strong>{int(result.report.lineCount)}件</strong></div>
        <div><span>税抜</span><strong>{yen(result.report.totals.amountExTax)}</strong></div>
        <div><span>税額</span><strong>{yen(result.report.totals.taxAmount)}</strong></div>
        <div><span>税込</span><strong>{yen(result.report.totals.amountIncTax)}</strong></div>
        {result.observations > 0 && <div><span>観測値だけの行</span><strong>{int(result.observations)}件</strong></div>}
      </div>
      <dl className="iw-result">
        {[['報告番号', result.report.reportKey], ['取引先', result.report.partnerName], ['作品', result.report.workTitle], ['報告の種類', kindLabel(result.report.kind)],
          ['対象期間', periodText(result.report.periodFrom, result.report.periodTo)], ['計上月', monthText(result.report.accountingMonth)], ['状態', labelOf('reportStatus', result.report.status)],
          ['登録日時', dateTimeJst(result.report.createdAt)], ['登録者', result.report.createdByName || '未確認']]
          .map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}
      </dl>
      {result.original && <p>訂正版として、元の報告（報告番号 {result.original.reportKey}・{int(result.original.lineCount)}件・税抜 {yen(result.original.totals.amountExTax)}）を置き換えました。</p>}
      {result.decision?.mode === 'separate' && <p>重なる報告（{result.decision.overlaps.length}件）があるため、別の報告として取り込みました。理由: {result.decision.reason}</p>}
      {result.split && result.split.partitions.length > 1 && (
        <p>1つの原本を{result.split.partitions.length}作品に分けた報告のうちの1件です（{bindingText({mode: result.split.mode, productColumn: result.split.productColumn, workColumn: result.split.workColumn})}・割り当て 版{result.split.bindingVersion}・{result.split.progress.label}）。</p>
      )}
      {result.exclusions?.count > 0 && (
        <div className="iw-excluded">
          <h4>取り込まなかった行（{result.exclusions.scope === 'file' ? '原本全体で' : ''}{int(result.exclusions.count)}行・税抜 {yen(result.exclusions.amountExTax)}{result.exclusions.unknown ? `・金額未確認 ${result.exclusions.unknown}行` : ''}）</h4>
          <table className="iw-mini">
            <thead><tr><th scope="col" className="num">原本の行</th><th scope="col">理由</th><th scope="col" className="num">税抜</th><th scope="col" className="num">税額</th><th scope="col" className="num">税込</th></tr></thead>
            <tbody>{result.exclusions.rows.map((row) => (
              <tr key={row.sourceRow}><td className="num">{row.sourceRow}</td><td>{row.reason}</td><td className="num">{row.amountExTax == null ? '未確認' : int(row.amountExTax)}</td><td className="num">{row.taxAmount == null ? '未確認' : int(row.taxAmount)}</td><td className="num">{row.amountIncTax == null ? '未確認' : int(row.amountIncTax)}</td></tr>
            ))}</tbody>
          </table>
        </div>
      )}
      {result.decision?.checks?.length > 0 && <p className="rp-muted">検算: {result.decision.checks.map(describeCheck).join('、')}（すべての行で一致）</p>}
      {result.source && (
        <details>
          <summary>原本と列対応の記録</summary>
          <dl className="iw-result">
            {[['ファイル', result.source.fileName || sourceName], ['シート', result.source.sheetName], ['見出しの行', `${result.source.headerRow}行目`], ['表の選択', `版${result.source.selectionVersion}`],
              ...(result.source.bindingVersion ? [['作品の割り当て', `版${result.source.bindingVersion}`]] : []),
              ['列対応', `${result.source.profileName || ''} 版${result.source.mappingVersionNo ?? '—'}`], ['原本のハッシュ（SHA-256）', result.source.rawHash]]
              .map(([label, value]) => <div key={label}><dt>{label}</dt><dd className={label.includes('ハッシュ') ? 'iw-code' : undefined}>{value}</dd></div>)}
          </dl>
        </details>
      )}
      <div className="on-form-actions">
        <button type="button" className="secondary" onClick={() => navigate('売上', {period: 'custom', from: result.report.accountingMonth, to: result.report.accountingMonth, partnerId: result.report.partnerId, q: result.report.reportKey})}>売上明細で見る</button>
        <button type="button" className="secondary" onClick={() => navigate('帳票センター', {report: 'annual-sales', partnerId: result.report.partnerId})}>帳票センターで見る</button>
      </div>
    </>
  );
}

// ---------- 本体 ----------
export function SalesImportWizard({data, request: requestProp, reload, onNavigate}) {
  const shell = useShell();
  const request = shell.isFallback ? (requestProp || shell.request) : shell.request;
  const navigate = useCallback((page, params) => (shell.isFallback ? onNavigate?.(page, params) : shell.navigate(page, params)), [shell, onNavigate]);
  const readOnly = Boolean(shell.readOnly);
  const partners = data?.partners || [];
  const products = data?.products || [];
  const allocations = data?.productAllocations || [];
  const bases = data?.recognitionBases || [];

  const [step, setStep] = useState(1);
  const [busy, setBusy] = useState(null);
  const [notice, setNotice] = useState(null);
  const [works, setWorks] = useState(null);
  const [limits, setLimits] = useState(null);
  const [context, setContext] = useState(null);
  const [contextVersion, setContextVersion] = useState(0);
  // 受領進捗の未受領セルなどから ?partner=ID&kind=digital で開いたときは、取引先と報告の種類を入れておく
  const [setup, setSetup] = useState(() => {
    const partnerParam = Number(shell.getParam?.('partner', '') || 0);
    const kindParam = shell.getParam?.('kind', '') || '';
    return {
      workId: data?.selectedWorkId || null,
      partnerId: partners.some((p) => p.id === partnerParam) ? partnerParam : null,
      kind: KINDS.includes(kindParam) ? kindParam : '',
      assignMode: 'single_work',
    };
  });
  const [kindNote, setKindNote] = useState('');
  const [correction, setCorrection] = useState(null);
  const [file, setFile] = useState(null);
  const [source, setSource] = useState(null);
  const [binding, setBinding] = useState(null);
  const [offer, setOffer] = useState(null);
  const [sheetName, setSheetName] = useState('');
  const [headerRow, setHeaderRow] = useState(null);
  const [headerManual, setHeaderManual] = useState(false);
  const [exclusions, setExclusions] = useState([]);
  const [selection, setSelection] = useState(null);
  const [selectionProblem, setSelectionProblem] = useState(null);
  const [fields, setFields] = useState(null);
  const [notes, setNotes] = useState({});
  const [fieldsFor, setFieldsFor] = useState('');
  const [fieldErrors, setFieldErrors] = useState([]);
  const [checks, setChecks] = useState([]);
  const [profileId, setProfileId] = useState(null);
  const [version, setVersion] = useState(null);
  const [draft, setDraft] = useState(null);
  const [plan, setPlan] = useState(null);
  const [planError, setPlanError] = useState(null);
  const [reportWorks, setReportWorks] = useState({});
  const [unmatchedMarks, setUnmatchedMarks] = useState({});
  const [partitions, setPartitionsState] = useState([]);
  const partitionsRef = useRef([]);
  // 登録の途中で最新の一覧を読むため、状態と同じものを ref にも持つ（順番に登録するときに古い一覧で判定しない）
  const setPartitions = useCallback((next) => {
    partitionsRef.current = typeof next === 'function' ? next(partitionsRef.current) : next;
    setPartitionsState(partitionsRef.current);
  }, []);
  const [tabs, setTabs] = useState({});
  const tabsRef = useRef({});
  const planSeq = useRef(0);
  const [activeId, setActiveId] = useState(null);
  const [controls, setControls] = useState({rowCount: '', amountExTax: '', amountIncTax: ''});
  const [marks, setMarks] = useState({});
  const [extraExclusion, setExtraExclusion] = useState({row: '', reason: ''});
  const [acceptedRows, setAcceptedRows] = useState([]);
  const [confirming, setConfirming] = useState(null);
  const [results, setResults] = useState([]);
  const [resultIndex, setResultIndex] = useState(0);
  const [legacyOpen, setLegacyOpen] = useState(false);
  const dropRef = useRef(null);

  // 未保存の途中（手順2〜5）を外枠に知らせる
  useEffect(() => {
    shell.registerUnsaved(UNSAVED_ID, step >= 2 && step < LAST_STEP ? 1 : 0, '売上報告の取込（途中）');
  }, [shell, step]);
  useEffect(() => () => shell.registerUnsaved(UNSAVED_ID, 0), [shell]);

  // 作品の一覧と上限
  useEffect(() => {
    let live = true;
    request('/sales-import/context').then((body) => {
      if (!live) return;
      setWorks(body.works || []);
      setLimits({...body.limits, reason: body.limitReason});
    }).catch((error) => live && setNotice({error, title: '取込の準備ができません'}));
    return () => { live = false; };
  }, [request]);

  // 訂正版の取込（売上明細の「訂正版を取り込む」から supersedes=報告ID で来る）。訂正は1つの作品の報告として取り込む
  const supersedesParam = shell.getParam('supersedes', '');
  useEffect(() => {
    const id = Number(supersedesParam || 0);
    if (!id) return undefined;
    let live = true;
    request(`/sales-import/reports/${id}`).then((body) => {
      if (!live) return;
      if (body.report.status !== 'active') {
        setNotice({tone: 'warn', message: body.replacedBy ? `この報告はすでに訂正版（報告番号 ${body.replacedBy.reportKey}）で置き換えられています。売上明細から最新の報告を選んで訂正してください。` : 'この報告はいま有効ではないため、訂正版を取り込めません。'});
        return;
      }
      setCorrection({id: body.report.id, reportKey: body.report.reportKey, report: body.report, fromUrl: true});
      setSetup({workId: body.report.workId, partnerId: body.report.partnerId, kind: body.report.kind, assignMode: 'single_work'});
    }).catch((error) => live && setNotice({error, title: '訂正する元の報告を読み込めません'}));
    return () => { live = false; };
  }, [supersedesParam, request]);

  const workAllowed = Boolean(works && setup.workId && works.some((work) => Number(work.id) === Number(setup.workId)));
  useEffect(() => {
    if (!works) return undefined;
    if (setup.workId && !workAllowed) setSetup((previous) => ({...previous, workId: works[0]?.id ?? null}));
    return undefined;
  }, [works, workAllowed, setup.workId]);

  // 取引先・報告の種類・作品が決まったら、前回の取込と最新の列対応を読む
  useEffect(() => {
    if (!works) return undefined;
    let live = true;
    const params = new URLSearchParams();
    if (workAllowed) params.set('workId', setup.workId);
    if (setup.partnerId) params.set('partnerId', setup.partnerId);
    if (setup.kind) params.set('kind', setup.kind);
    request(`/sales-import/context?${params}`).then((body) => {
      if (!live) return;
      setContext({...body, loadedFor: `${setup.partnerId || ''}|${setup.kind || ''}`});
      setProfileId(body.profile?.id ?? null);
    }).catch((error) => live && setNotice({error, title: '前回の取込を読み込めません'}));
    return () => { live = false; };
  }, [works, workAllowed, setup.workId, setup.partnerId, setup.kind, request, contextVersion]);
  // 列対応の版は「取引先×報告の種類」ごと。組み合わせが変わったら前の版と列の候補を捨て、手順3で作り直す
  const mappingKey = `${setup.partnerId || ''}|${setup.kind || ''}`;
  useEffect(() => {
    setVersion(null);
    setFieldsFor('');
  }, [mappingKey]);

  const splitMode = setup.assignMode !== 'single_work';
  const partner = partners.find((item) => Number(item.id) === Number(setup.partnerId)) || null;
  const work = (works || []).find((item) => Number(item.id) === Number(setup.workId)) || null;
  const productChoices = useMemo(() => (splitMode ? [] : productChoicesFor({products, allocations, kind: setup.kind, workId: setup.workId})), [products, allocations, setup.kind, setup.workId, splitMode]);
  // 売上集計シートの拡張属性の列は、組織が採用して使っている列だけを出す（取込の文脈から）
  const attributeColumns = useMemo(() => context?.attributeColumns || [], [context]);
  // 列対応で固定した商品が、割り当てた作品に結び付いているかを確かめるためのマスタ（手順4）
  const masters = useMemo(() => ({products, allocations, kind: setup.kind, works: works || []}), [products, allocations, setup.kind, works]);

  const sheets = source?.extraction?.sheets || [];
  const sheet = sheets.find((item) => item.name === sheetName) || sheets[0] || null;
  const detection = useMemo(() => (sheet ? detectHeaderRow(sheet.rows) : null), [sheet]);
  const totalRows = useMemo(() => (sheet && headerRow ? detectTotalRows(sheet.rows, headerRow) : []), [sheet, headerRow]);
  const headerIssues = useMemo(() => (sheet && headerRow ? headerProblems(sheet.rows[headerRow - 1]) : []), [sheet, headerRow]);
  const headers = selection?.headers || [];
  const autoKey = autoReportKey({partnerCode: partner?.code, partnerId: setup.partnerId, periodFrom: fields?.period_from?.value, rawHash: source?.rawHash});

  // 登録の進み具合。1件でも登録したら、割り当て・表の選択・分け方は変えられない（サーバーのトリガーでも止める）
  const progress = useMemo(() => commitProgress(partitions.map((item) => ({committed: Boolean(item.committed)}))), [partitions]);
  const locked = Boolean(source?.locked) || progress.started;
  const activePartition = partitions.find((item) => item.id === activeId) || partitions[0] || null;

  // 作品ごとの確認の状態（行・合計・重なり・登録できない理由）
  const statusOf = useCallback((partition, tab) => {
    if (!partition || !version) return null;
    const current = tab || EMPTY_TAB;
    const rows = buildReviewRows({selection: partitionSelection(partition), mappings: version.definition.mappings, preview: current.preview, checks, totalRows, acceptedRows});
    const totals = reviewTotals(rows);
    const reportErrors = reportLevelErrors(current.preview);
    const overlapRows = current.overlaps?.overlaps || [];
    const decision = current.decision || EMPTY_DECISION;
    const commitDecision = correction ? {mode: 'supersede', reason: decision.reason} : overlapRows.length ? {mode: decision.mode === 'separate' ? 'separate' : '', reason: decision.reason} : null;
    const overlapProblem = current.overlaps ? overlapDecisionProblem(overlapRows, commitDecision, correction?.id ?? null) : null;
    const blockers = [];
    if (!partition.committed) {
      if (!current.preview && !current.previewError) blockers.push(rows.some((row) => row.status === 'error') ? '計算できない値がある行があります。取り込まない行にするか、元のファイルを直してください' : '表の確認がまだです');
      if (current.previewError) blockers.push('確認でエラーになりました（上の理由を見てください）');
      if (totals.errors) blockers.push(`エラーの行が${totals.errors}行あります。取り込まない行にするか、元のファイルを直して読み込み直してください`);
      if (totals.warnings) blockers.push(`合計行の可能性がある行が${totals.warnings}行あります。取り込まない行にするか、明細として取り込むと決めてください`);
      if (reportErrors.length) blockers.push(...reportErrors);
      if (current.preview && !current.preview.ok && !totals.errors && !reportErrors.length) blockers.push('確認でエラーがあります');
      if (overlapProblem) blockers.push(overlapProblem);
      if (!totals.count) blockers.push('取り込む売上の行がありません');
    }
    const rowProblems = !partition.committed && (Boolean(totals.errors || totals.warnings || reportErrors.length || current.previewError) || (!current.preview && !current.previewError));
    return {rows, totals, reportErrors, overlapRows, commitDecision, overlapProblem, blockers, rowProblems, decision};
  }, [version, checks, totalRows, acceptedRows, correction]);
  const statuses = useMemo(() => new Map(partitions.map((item) => [item.id, statusOf(item, tabs[item.id])])), [partitions, tabs, statusOf]);
  const activeStatus = activePartition ? statuses.get(activePartition.id) : null;
  const activeTab = (activePartition && tabs[activePartition.id]) || EMPTY_TAB;
  const reviewRows = activeStatus?.rows || [];
  const totals = activeStatus?.totals || reviewTotals([]);
  const fileTotals = useMemo(() => {
    const out = {count: 0, amount_ex_tax: 0, tax_amount: 0, amount_inc_tax: 0};
    for (const status of statuses.values()) if (status) for (const key of Object.keys(out)) out[key] += status.totals[key] || 0;
    return out;
  }, [statuses]);
  const controlResults = useMemo(() => compareControls(controls, fileTotals), [controls, fileTotals]);
  const overlapRows = activeStatus?.overlapRows || [];
  const decision = activeStatus?.decision || EMPTY_DECISION;

  function patchTab(id, patch) {
    const current = tabsRef.current[id] || EMPTY_TAB;
    const next = {...current, ...(typeof patch === 'function' ? patch(current) : patch)};
    tabsRef.current = {...tabsRef.current, [id]: next};
    setTabs(tabsRef.current);
  }
  function resetTabs() {
    tabsRef.current = {};
    setTabs({});
  }
  const setDecision = (updater) => activePartition && patchTab(activePartition.id, (current) => ({decision: typeof updater === 'function' ? updater(current.decision || EMPTY_DECISION) : updater}));

  function resetFrom(stepNo) {
    if (stepNo <= 1) { setSource(null); setBinding(null); setOffer(null); setSheetName(''); setHeaderRow(null); setHeaderManual(false); setExclusions([]); }
    // シート・見出しの行を変えると行番号の意味が変わるので、取り込まない行の指定も捨てる（別の行を理由つきで除外しないように）
    if (stepNo <= 2) { setSelection(null); setSelectionProblem(null); setExclusions([]); }
    if (stepNo <= 3) {
      setDraft(null); setPlan(null); setPlanError(null); setUnmatchedMarks({}); setPartitions([]); resetTabs(); setActiveId(null);
      setMarks({}); setAcceptedRows([]); setConfirming(null);
    }
  }

  function restart() {
    resetFrom(1);
    setFields(null); setFieldsFor(''); setVersion(null); setFile(null); setResults([]); setResultIndex(0); setReportWorks({});
    setControls({rowCount: '', amountExTax: '', amountIncTax: ''}); setNotice(null); setCorrection(null);
    if (supersedesParam) shell.setParam('supersedes', null, {replace: true});
    setContextVersion((value) => value + 1);
    setStep(1);
  }

  function chooseSource(next) {
    setSource(next);
    const list = next.extraction?.sheets || [];
    const scored = list.map((item) => ({name: item.name, detection: detectHeaderRow(item.rows || [])}));
    const best = [...scored].sort((a, b) => (b.detection.candidates[0]?.score || 0) - (a.detection.candidates[0]?.score || 0))[0];
    setSheetName(best?.name || list[0]?.name || '');
    setHeaderRow(best?.detection.row ?? null);
    setHeaderManual(false);
    resetFrom(2);
    resetFrom(3);
  }

  // ---------- 手順1 → 2 ----------
  async function pickFile(chosen) {
    if (!chosen) return;
    setNotice(null);
    if (chosen.size > MAX_FILE_BYTES) { setNotice({tone: 'error', message: `ファイルが大きすぎます（${fileSizeText(chosen.size)}）。6MBまでのファイルにしてください`}); return; }
    if (!/\.(xlsx|csv|txt|pdf)$/i.test(chosen.name)) { setNotice({tone: 'error', message: '読み込めるのは Excel（.xlsx）・CSV・文字のあるPDF です'}); return; }
    const bytes = new Uint8Array(await chosen.arrayBuffer());
    let encoding = null;
    if (/\.(csv|txt)$/i.test(chosen.name)) encoding = ENCODING_LABELS[detectEncoding(bytes)];
    setFile({file: chosen, name: chosen.name, size: chosen.size, bytes, encoding, kindLabel: /\.xlsx$/i.test(chosen.name) ? 'Excel' : /\.pdf$/i.test(chosen.name) ? 'PDF' : 'CSV'});
    if (source) resetFrom(1);
  }

  // 受け取り済みの原本を開き直す（割り当て・最後の表の選択・登録の進み具合を読み込む）
  async function openFile(fileId) {
    const body = await request(`/sales-import/files/${fileId}`);
    const saved = selectionFromSaved(body.selection);
    const lockedNow = !body.canRebind;
    const terms = body.commitTerms || null;
    chooseSource({fileId: body.file.id, fileName: body.file.fileName, rawHash: body.file.rawHash, extraction: body.file.extraction, locked: lockedNow, savedSelection: saved, commitTerms: terms});
    // 登録を始めた原本は、最初の登録と同じ取引先・報告の種類で続ける（サーバーでも止める。取引先・種類は手順1で変えられないようにする）
    if (terms) setSetup((previous) => ({...previous, partnerId: terms.partnerId, kind: terms.kind}));
    if (saved) {
      setSheetName(saved.sheetName);
      setHeaderRow(saved.headerRow);
      setHeaderManual(true);
      setExclusions((saved.excluded.rows || []).map((row) => ({...row})));
    }
    setBinding(body.binding);
    if (body.binding) setSetup((previous) => ({...previous, assignMode: body.binding.mode, workId: body.binding.mode === 'single_work' ? body.binding.workId : previous.workId}));
    setStep(2);
    return body;
  }

  // 旧方式の原本（登録前）を引き継ぐ。rebind を渡すと、引き継いだうえで理由つきで付け替える
  async function takeover(artifactId, rebind = null) {
    const body = await request('/sales-import/files/takeover', {method: 'POST', body: {artifactId, ...(rebind || {})}});
    return openFile(body.fileId);
  }

  async function startFromFile() {
    const single = setup.assignMode === 'single_work';
    if ((single && !setup.workId) || !setup.partnerId || !setup.kind) { setNotice({tone: 'error', message: single ? '作品・取引先・報告の種類を選んでください' : '取引先・報告の種類を選んでください'}); return; }
    if (!file) { setNotice({tone: 'error', message: '取り込むファイルを選んでください'}); return; }
    if (source && source.fileName === file.name) { setStep(2); return; }
    setBusy('upload');
    setNotice(null);
    setOffer(null);
    try {
      const hash = await sha256Hex(file.bytes);
      const found = await request(`/sales-import/artifacts/lookup?sha256=${hash}`);
      if (found.restricted) { setNotice({tone: 'error', message: restrictedFileMessage(found.restrictedReason)}); return; }
      if (found.file) {
        const saved = found.file;
        if (saved.complete) {
          setNotice({tone: 'warn', title: 'このファイルは登録済みです', message: `${dateTimeJst(saved.committedAt)} に登録しました（${saved.progressLabel}）。同じファイルは二重に登録できません。直すときは売上明細から「訂正版を取り込む」を使います。`,
            actions: saved.reportIds?.length ? <button type="button" className="secondary" onClick={() => openResults(saved.reportIds)}>登録結果を見る</button> : null});
          return;
        }
        if (single && saved.binding?.mode === 'single_work' && Number(saved.binding.workId) !== Number(setup.workId) && !saved.committed) {
          setOffer({legacy: false, id: saved.id, fromWorkId: saved.binding.workId, fromTitle: saved.binding.workTitle, toWorkId: Number(setup.workId), toTitle: work?.title, reason: ''});
          return;
        }
        await openFile(saved.id);
        setNotice({tone: 'info', message: saved.committed ? `このファイルは${saved.progressLabel}です。続きから登録します` : `このファイルは ${dateTimeJst(saved.createdAt)} に受け取り済みです。続きから進めます`});
        return;
      }
      if (found.artifact) {
        const legacy = found.artifact;
        if (legacy.committed) {
          setNotice({tone: 'warn', title: 'このファイルは登録済みです', message: `${dateTimeJst(legacy.committedAt)} に登録しました（作品「${legacy.workTitle}」）。同じファイルは二重に登録できません。直すときは売上明細から「訂正版を取り込む」を使います。`,
            actions: legacy.reportId ? <button type="button" className="secondary" onClick={() => openResults([legacy.reportId])}>登録結果を見る</button> : null});
          return;
        }
        if (single && Number(legacy.workId) !== Number(setup.workId)) {
          setOffer({legacy: true, id: legacy.id, fromWorkId: legacy.workId, fromTitle: legacy.workTitle, toWorkId: Number(setup.workId), toTitle: work?.title, reason: ''});
          return;
        }
        await takeover(legacy.id);
        setNotice({tone: 'info', message: `このファイルは ${dateTimeJst(legacy.createdAt)} に読み込み済みです（旧方式の原本を引き継ぎました）。続きから進めます`});
        return;
      }
      const body = await request('/sales-import/files', {method: 'POST', body: {name: file.name, base64: bytesToBase64(file.bytes), mediaType: file.file.type || null, binding: single ? {mode: 'single_work', workId: Number(setup.workId)} : null}});
      chooseSource({fileId: body.fileId, fileName: file.name, rawHash: body.rawHash, extraction: body.extraction, locked: false, savedSelection: null});
      setBinding(single ? {id: body.bindingId, versionNo: 1, mode: 'single_work', workId: Number(setup.workId), workTitle: work?.title || null, reason: '受け取ったときの割り当て'} : null);
      setStep(2);
    } catch (error) {
      if (error?.status === 409 && error.details?.fileId) {
        await openFile(error.details.fileId).catch((failure) => setNotice({error: failure}));
        return;
      }
      setNotice({error, title: 'ファイルを読み込めませんでした',
        message: error?.status === 503 ? 'この環境では原本の読み取り（抽出）を使えません。管理者に抽出の設定を確かめてもらってください'
          : error?.status === 422 ? '表を読み取れませんでした。画像だけのPDFは読めません。文字のあるPDFか、Excel・CSVで取り込んでください' : undefined});
    } finally {
      setBusy(null);
    }
  }

  async function acceptOffer(rebind) {
    if (!offer) return;
    setBusy('upload');
    setNotice(null);
    try {
      if (offer.legacy) {
        await takeover(offer.id, rebind ? {binding: {mode: 'single_work', workId: offer.toWorkId}, reason: offer.reason.trim()} : null);
      } else {
        if (rebind) await request(`/sales-import/files/${offer.id}/bindings`, {method: 'POST', body: {mode: 'single_work', workId: offer.toWorkId, reason: offer.reason.trim()}});
        await openFile(offer.id);
      }
      if (!rebind) setSetup((previous) => ({...previous, workId: offer.fromWorkId}));
      setNotice({tone: rebind ? 'ok' : 'info', message: rebind ? `作品「${offer.toTitle || ''}」に付け替えました。続きから進めます` : `作品「${offer.fromTitle || ''}」の原本として続けます`});
      setOffer(null);
    } catch (error) {
      setNotice({error, title: rebind ? '付け替えられませんでした' : '続きを開けませんでした'});
    } finally {
      setBusy(null);
    }
  }

  function resumeFile(fileId) {
    setBusy('upload');
    setNotice(null);
    openFile(fileId).catch((error) => setNotice({error, title: '続きを開けませんでした'})).finally(() => setBusy(null));
  }

  function resumeLegacy(artifactId) {
    setBusy('upload');
    setNotice(null);
    takeover(artifactId).then(() => setNotice({tone: 'info', message: '旧方式の原本を引き継ぎました。続きから進めます'}))
      .catch((error) => setNotice({error, title: '続きを開けませんでした'})).finally(() => setBusy(null));
  }

  // ---------- 手順2 → 3 ----------
  async function makeSelection(nextExclusions, versionId) {
    const body = await request(`/sales-import/files/${source.fileId}/selection`, {method: 'POST', body: {sheetName: sheet.name, headerRow, excludedRows: nextExclusions.map(({sourceRow, reason}) => ({sourceRow, reason})), mappingVersionId: versionId || undefined}});
    const next = {...body, mappingVersionId: versionId || null};
    setSelection(next);
    setExclusions((body.excluded?.rows || []).map((row) => ({...row})));
    setSelectionProblem(null);
    return next;
  }

  function selectionFailure(error) {
    const details = Array.isArray(error?.details) ? error.details : [];
    const rows = details.map((item) => Number(item.row)).filter(Boolean);
    setSelectionProblem({error, rows});
  }

  async function confirmHeader() {
    if (!headerRow) { setNotice({tone: 'error', message: '見出しの行を選んでください'}); return; }
    if (headerIssues.length) { setNotice({tone: 'error', message: '見出しの行に空欄か同じ名前の列があります。別の行を選んでください', details: headerIssues.map((item) => ({column: item.column, message: item.message}))}); return; }
    setBusy('select');
    setNotice(null);
    try {
      // 登録を始めた原本は、保存した表の選択をそのまま使う（選び直せない）
      const body = source.locked && source.savedSelection ? source.savedSelection : await makeSelection(exclusions, version?.id);
      if (source.locked && source.savedSelection) setSelection(body);
      const key = `${source.fileId}:${body.headers.join('\u0001')}:${setup.assignMode}`;
      if (fieldsFor !== key) {
        const sample = selectionRows(body.canonicalCsv, body.sourceRowNumbers).slice(0, 50).map((row) => body.headers.map((header) => row.values[header]));
        const init = defaultFields({headers: body.headers, sampleRows: sample, previous: context?.mapping ? {definition: context.mapping.definition, versionNo: context.mapping.versionNo} : null,
          attributeTargets: context?.attributeTargets || [], productIds: productChoices.map((product) => product.id), period: guessPeriod(body.headers, sample), assignMode: setup.assignMode});
        setFields(init.fields);
        setNotes(init.notes);
        setFieldsFor(key);
        setFieldErrors([]);
        const previousChecks = Array.isArray(context?.checks) ? context.checks.filter((check) => validateChecks([check], body.headers).length === 0) : [];
        setChecks(previousChecks);
        setVersion(null);
      }
      resetFrom(3);
      setStep(3);
    } catch (error) {
      selectionFailure(error);
    } finally {
      setBusy(null);
    }
  }

  function excludeProblemRows() {
    if (!selectionProblem?.rows?.length) return;
    const extra = selectionProblem.rows.filter((row) => !exclusions.some((item) => item.sourceRow === row)).map((row) => ({sourceRow: row, reason: '列の数が見出しと合わない行のため'}));
    setExclusions([...exclusions, ...extra]);
    setSelectionProblem(null);
    setNotice({tone: 'info', message: `${extra.length}行を取り込まない行にしました。もう一度「次へ」を押してください（取り込まない行は手順5で見直せます）`});
  }

  // ---------- 手順3 → 4 ----------
  async function ensureVersion(definition) {
    if (version && version.mappingKey === mappingKey && sameDefinition(version.definition, definition)) return version;
    // 読み込んだ前回の列対応が、いまの取引先×報告の種類のものか（切り替え直後の古い読込や別の組み合わせの版を使わない）
    if (context?.loadedFor !== mappingKey) throw new Error('取引先・報告の種類の列対応を読み込み中です。少し待ってからもう一度押してください');
    if (context?.mapping?.definition && sameDefinition(context.mapping.definition, definition)) return {id: context.mapping.id, versionNo: context.mapping.versionNo, definition, mappingKey};
    let id = profileId;
    if (!id) {
      const created = await request('/mapping-profiles', {method: 'POST', body: {partnerId: Number(setup.partnerId), kind: setup.kind, name: `${partner?.name || '取引先'}｜${kindLabel(setup.kind)}`.slice(0, 120)}});
      id = created.profileId;
      setProfileId(id);
    }
    const saved = await request(`/mapping-profiles/${id}/versions`, {method: 'POST', body: definition});
    return {id: saved.mappingVersionId, versionNo: saved.versionNo, definition, mappingKey};
  }

  function draftFrom(current, sel) {
    const list = sel?.headers || [];
    if (current) return {mode: current.mode, workId: current.workId ?? setup.workId ?? null, productColumn: current.productColumn || '', workColumn: current.workColumn || '',
      useProductColumn: current.mode === 'by_product' || Boolean(current.productColumn), reason: '', editing: false};
    return {mode: setup.assignMode, workId: setup.workId ?? null, productColumn: guessSplitColumn(list, 'product') || '', workColumn: guessSplitColumn(list, 'work') || '',
      useProductColumn: setup.assignMode === 'by_product' || fields?.product_id?.mode === 'resolved', reason: '', editing: true};
  }

  // 割り当ての試し（保存しない）。下書きが変わるたびに作品ごとの行数・税抜合計・照合できない行を出し直す
  async function runPlan(nextDraft = draft, ver = version, sel = selection, works2 = reportWorks) {
    const seq = ++planSeq.current;
    const spec = locked ? null : draftBinding(nextDraft);
    if (!spec && !locked) { setPlan(null); setPlanError(null); return null; }
    try {
      const body = await request(`/sales-import/files/${source.fileId}/partitions`, {method: 'POST', body: {dryRun: true, binding: spec, kind: setup.kind, mappingVersionId: ver?.id, reportWorks: works2, selectionId: sel?.selectionId}});
      if (seq !== planSeq.current) return null;
      setPlan(body);
      setPlanError(null);
      if (body.locked && !locked) setSource((previous) => ({...previous, locked: true}));
      return body;
    } catch (error) {
      if (seq !== planSeq.current) return null;
      setPlan(null);
      setPlanError(error);
      return null;
    }
  }

  async function saveMappingAndAssign() {
    const built = buildDefinition(fields, {headers, partnerId: setup.partnerId, autoKey, correction: correction ? {id: correction.id, reportKey: correction.reportKey} : null, resolvedProduct: splitMode});
    const checkErrors = validateChecks(checks, headers);
    setFieldErrors(built.errors);
    if (built.errors.length || checkErrors.length) {
      setNotice({tone: 'error', title: '列の対応に足りないところがあります', details: [...built.errors.map((error) => ({column: error.target === 'basis_date' ? '計上基準の日付' : TARGET_LABELS[error.target] || FIELD_SPECS.find((spec) => spec.key === error.target)?.label || null, message: error.message})), ...checkErrors.map((message) => ({column: '検算', message}))]});
      return false;
    }
    setBusy('review');
    setNotice(null);
    try {
      const ver = await ensureVersion(built.definition);
      setVersion(ver);
      let sel = selection;
      if (!locked && exclusions.length && sel.mappingVersionId !== ver.id) sel = await makeSelection(exclusions, ver.id);
      // 手順4で付け替えの途中だった下書きは残す（手順3で商品の取り方を直して戻ったとき）
      const nextDraft = draft?.editing && binding ? draft : draftFrom(binding, sel);
      setDraft(nextDraft);
      setStep(4);
      await runPlan(nextDraft, ver, sel);
      return true;
    } catch (error) {
      setNotice({error, title: '列の対応を保存できませんでした'});
      return false;
    } finally {
      setBusy(null);
    }
  }

  // ---------- 手順4 ----------
  function changeDraft(patch) {
    const next = {...draft, ...patch};
    setDraft(next);
    if (['mode', 'workId', 'productColumn', 'workColumn', 'useProductColumn'].some((key) => Object.hasOwn(patch, key))) runPlan(next);
  }

  function chooseReportWork(productId, workId) {
    const next = {...reportWorks, [productId]: Number(workId)};
    setReportWorks(next);
    runPlan(draft, version, selection, next);
  }

  // 照合できなかった行を、理由つきで取り込まない行にして分け直す（推測で作品を決めない）
  async function excludeUnmatched() {
    const chosen = Object.entries(unmatchedMarks).filter(([, mark]) => mark.checked).map(([row, mark]) => ({sourceRow: Number(row), reason: String(mark.reason ?? '').trim()}));
    if (!chosen.length) { setNotice({tone: 'error', message: '取り込まない行を選んでください'}); return; }
    const missing = chosen.filter((item) => !item.reason);
    if (missing.length) { setNotice({tone: 'error', message: `理由が空の行があります（${missing.map((item) => `${item.sourceRow}行目`).join('、')}）。取り込まない理由は必ず書きます`}); return; }
    setBusy('select');
    setNotice(null);
    try {
      const sel = await makeSelection([...exclusions, ...chosen.filter((item) => !exclusions.some((row) => row.sourceRow === item.sourceRow))], version.id);
      setUnmatchedMarks({});
      await runPlan(draft, version, sel);
      setNotice({tone: 'ok', message: `${chosen.length}行を取り込まない行にして、分け直しました`});
    } catch (error) {
      setNotice({error, title: '取り込まない行を反映できませんでした'});
    } finally {
      setBusy(null);
    }
  }

  function applyPartitions(list) {
    setPartitions(list);
    resetTabs();
    setActiveId((list.find((item) => !item.committed) || list[0])?.id ?? null);
  }

  async function reviewPartition(partition, ver = version) {
    patchTab(partition.id, {preview: null, previewError: null, overlaps: null});
    const local = buildReviewRows({selection: partitionSelection(partition), mappings: ver.definition.mappings, preview: null, checks: [], totalRows: []});
    if (local.some((row) => row.issues.some((issue) => issue.kind === 'error'))) return;
    let body;
    try {
      body = await request('/mapped-imports/preview', {method: 'POST', body: {workId: partition.workId, mappingVersionId: ver.id, text: partition.csv, sourcePartitionId: partition.id}});
    } catch (error) {
      patchTab(partition.id, {previewError: error});
      return;
    }
    let overlaps = null;
    let previewError = null;
    if (body.ok && body.token) {
      try { overlaps = await request(`/sales-import/overlaps?token=${encodeURIComponent(body.token)}`); } catch (error) { previewError = error; }
    }
    patchTab(partition.id, {preview: body, overlaps, previewError});
  }

  async function reviewAll(list, ver = version) {
    for (const partition of list) if (!partition.committed && partition.csv) await reviewPartition(partition, ver);
  }

  // 割り当てを保存し（付け替えなら理由つきの新しい版）、作品ごとに分けて、すべての作品の表を確かめる
  async function confirmAssignment() {
    const spec = draftBinding(draft);
    if (!locked && !spec) { setNotice({tone: 'error', message: '作品の決め方を最後まで選んでください'}); return; }
    const fit = mappingFitsBinding(version?.definition, locked ? binding : spec, masters);
    if (fit) { setNotice({tone: 'error', message: fit}); return; }
    setBusy('assign');
    setNotice(null);
    try {
      if (!locked && (!binding || !sameBinding(binding, spec))) {
        if (binding && !draft.reason.trim()) { setNotice({tone: 'error', message: '付け替える理由を書いてください（付け替えの記録に残ります）'}); return; }
        const saved = await request(`/sales-import/files/${source.fileId}/bindings`, {method: 'POST', body: {...spec, reason: binding ? draft.reason.trim() : undefined, expectedVersion: binding?.versionNo ?? 0}});
        setBinding(saved.binding);
        setDraft((previous) => ({...previous, reason: '', editing: false}));
        // 手順1の作品・手順3の商品の選択肢は setup から作るので、保存した割り当てに合わせる
        setSetup((previous) => ({...previous, assignMode: spec.mode, workId: spec.mode === 'single_work' ? spec.workId : previous.workId}));
      }
      const body = await request(`/sales-import/files/${source.fileId}/partitions`, {method: 'POST', body: {kind: setup.kind, mappingVersionId: version.id, reportWorks, selectionId: locked ? undefined : selection.selectionId}});
      setPlan(body);
      if (!body.ok || !body.saved) {
        setNotice({tone: 'warn', title: 'まだ作品に割り当てられない行があります', message: '下の「割り当てられない行」を、理由を書いて取り込まない行にするか、作品商品マスタを直してからもう一度押してください。'});
        return;
      }
      if (body.locked) setSource((previous) => ({...previous, locked: true}));
      applyPartitions(body.partitions);
      setStep(5);
      setBusy('review');
      await reviewAll(body.partitions);
    } catch (error) {
      setNotice({error, title: '作品に割り当てられませんでした'});
    } finally {
      setBusy(null);
    }
  }

  // ---------- 手順5 ----------
  async function reselect(nextExclusions) {
    if (locked) { setNotice({tone: 'warn', message: '登録を始めた原本は、取り込まない行を変えられません。登録した報告を直すときは、登録後に訂正版を取り込みます'}); return false; }
    setBusy('review');
    setNotice(null);
    try {
      const sel = await makeSelection(nextExclusions, version.id);
      setMarks({});
      const body = await request(`/sales-import/files/${source.fileId}/partitions`, {method: 'POST', body: {kind: setup.kind, mappingVersionId: version.id, reportWorks, selectionId: sel.selectionId}});
      setPlan(body);
      if (!body.ok || !body.saved) { setStep(4); setNotice({tone: 'warn', message: '分け直した結果、作品に割り当てられない行があります。割り当てを見直してください'}); return false; }
      applyPartitions(body.partitions);
      await reviewAll(body.partitions);
      return true;
    } catch (error) {
      setNotice({error, title: '取り込まない行を反映できませんでした'});
      return false;
    } finally {
      setBusy(null);
    }
  }

  async function applyExclusions() {
    const chosen = Object.entries(marks).filter(([, mark]) => mark.checked).map(([row, mark]) => ({sourceRow: Number(row), reason: String(mark.reason ?? '').trim()}));
    const extraRow = Number(extraExclusion.row);
    if (extraExclusion.row !== '') {
      if (!selection.sourceRowNumbers.includes(extraRow)) { setNotice({tone: 'error', message: `${extraExclusion.row}行目は取り込む行にありません`}); return; }
      chosen.push({sourceRow: extraRow, reason: extraExclusion.reason.trim()});
    }
    if (!chosen.length) { setNotice({tone: 'error', message: '取り込まない行を選んでください'}); return; }
    const missing = chosen.filter((item) => !item.reason);
    if (missing.length) { setNotice({tone: 'error', message: `理由が空の行があります（${missing.map((item) => `${item.sourceRow}行目`).join('、')}）。取り込まない理由は必ず書きます`}); return; }
    const ok = await reselect([...exclusions, ...chosen.filter((item) => !exclusions.some((row) => row.sourceRow === item.sourceRow))]);
    if (ok) {
      setExtraExclusion({row: '', reason: ''});
      setNotice({tone: 'ok', message: `${chosen.length}行を取り込まない行にして、もう一度確かめました`});
    }
  }

  async function restoreExclusion(sourceRow) {
    const ok = await reselect(exclusions.filter((row) => row.sourceRow !== sourceRow));
    if (ok) setNotice({tone: 'info', message: `${sourceRow}行目を取り込む行に戻して、もう一度確かめました`});
  }

  // 訂正版にする・やめる: 列対応（報告番号・訂正元）を作り直して、作品の表を確かめ直す
  async function remapAndReview(nextCorrection) {
    const built = buildDefinition(fields, {headers, partnerId: setup.partnerId, autoKey, correction: nextCorrection ? {id: nextCorrection.id, reportKey: nextCorrection.reportKey} : null, resolvedProduct: splitMode});
    if (built.errors.length) { setNotice({tone: 'error', title: '列の対応に足りないところがあります', details: built.errors.map((error) => ({message: error.message}))}); return false; }
    setBusy('review');
    try {
      const ver = await ensureVersion(built.definition);
      setVersion(ver);
      await reviewAll(partitions, ver);
      return true;
    } catch (error) {
      setNotice({error, title: '確かめ直せませんでした'});
      return false;
    } finally {
      setBusy(null);
    }
  }

  async function applyCorrection(target) {
    if (!target) { setNotice({tone: 'error', message: '訂正する元の報告を選んでください'}); return; }
    const next = {id: target.id, reportKey: target.reportKey, report: target, fromUrl: false};
    setCorrection(next);
    const ok = await remapAndReview(next);
    if (ok) setNotice({tone: 'info', message: `報告番号「${target.reportKey}」の訂正版として確かめ直しました`});
  }

  async function cancelCorrection() {
    const wasUrl = correction?.fromUrl;
    setCorrection(null);
    if (wasUrl) shell.setParam('supersedes', null, {replace: true});
    if (step === 5) {
      const ok = await remapAndReview(null);
      if (ok) setNotice({tone: 'info', message: '訂正をやめて、新しい報告として確かめ直しました'});
    }
  }

  function downloadFailedRows() {
    const name = (source?.fileName || '売上報告').replace(/\.[^.]+$/, '');
    downloadXlsx(`${name}_失敗行.xlsx`, [{name: '失敗行', rows: failedRowsSheet(activePartition?.headers || headers, reviewRows)}]);
  }

  async function openResults(reportIds, warnings = {}) {
    setBusy('result');
    try {
      const list = [];
      for (const reportId of reportIds) {
        const body = await request(`/sales-import/reports/${reportId}`);
        list.push({...body, auditWarning: warnings[reportId] || null});
      }
      setResults(list);
      setResultIndex(0);
      setStep(LAST_STEP);
    } catch (error) {
      setNotice({error, title: '登録結果を読み込めませんでした'});
    } finally {
      setBusy(null);
    }
  }

  const auditWarnings = useRef({});
  // 1作品ぶんを登録する。成功したら登録済みにする（返り値は登録後の一覧）
  async function commitOne(partition) {
    const tab = tabsRef.current[partition.id] || EMPTY_TAB;
    const status = statusOf(partition, tab);
    const body = await request('/sales-import/commit', {method: 'POST', body: {token: tab.preview.token, checks, decision: status.commitDecision, kind: setup.kind, partnerId: Number(setup.partnerId)}});
    if (body.auditWarning) auditWarnings.current[body.reportId] = body.auditWarning;
    setPartitions((previous) => previous.map((item) => (item.id === partition.id ? {...item, committed: {reportId: body.reportId, committedAt: new Date().toISOString()}} : item)));
    return partitionsRef.current;
  }

  async function finishIfDone(list) {
    const current = list || partitionsRef.current;
    if (current.length && current.every((item) => item.committed)) {
      shell.registerUnsaved(UNSAVED_ID, 0);
      if (correction?.fromUrl) shell.setParam('supersedes', null, {replace: true});
      await openResults(current.map((item) => item.committed.reportId).filter(Boolean), auditWarnings.current);
      reload?.();
      return true;
    }
    return false;
  }

  async function commitActive() {
    if (!activePartition) return;
    setBusy('commit');
    setNotice(null);
    try {
      const list = await commitOne(activePartition);
      setConfirming(null);
      if (await finishIfDone(list)) return;
      const next = list.find((item) => !item.committed);
      if (next) setActiveId(next.id);
      setNotice({tone: 'ok', message: `作品「${workName(activePartition)}」を登録しました（${commitProgress(list.map((item) => ({committed: Boolean(item.committed)}))).label}）。${next ? `次は作品「${workName(next)}」です` : ''}`});
      reload?.();
    } catch (error) {
      setConfirming(null);
      if (error?.status === 410) {
        setNotice({tone: 'warn', message: '確かめてから時間がたったため、この作品の確認をやり直しました。内容を見直してから登録してください'});
        await reviewPartition(activePartition);
      } else setNotice({error, title: '登録できませんでした'});
    } finally {
      setBusy(null);
    }
  }

  // まだの作品をすべて順番に登録する。止まる理由がある作品で止め、その作品を開く（途中までの登録は残る）
  async function commitAll() {
    setBusy('commit');
    setNotice(null);
    setConfirming(null);
    let list = partitionsRef.current;
    try {
      const pending = list.filter((item) => !item.committed);
      // 最初の登録の前は、すべての作品の表にエラーが無いことを求める（登録を始めると取り込まない行を変えられないため）
      if (!list.some((item) => item.committed)) {
        const unready = pending.filter((item) => statusOf(item, tabsRef.current[item.id])?.rowProblems);
        if (unready.length) {
          setActiveId(unready[0].id);
          setNotice({tone: 'warn', message: `エラーか未確認が残っている作品があります（${unready.map((item) => `「${workName(item)}」`).join('、')}）。取り込まない行は登録を始める前に決めます`});
          return;
        }
      }
      for (const partition of pending) {
        const status = statusOf(partition, tabsRef.current[partition.id]);
        if (status.blockers.length) {
          setActiveId(partition.id);
          setNotice({tone: 'warn', title: `作品「${workName(partition)}」で止めました（${commitProgress(list.map((item) => ({committed: Boolean(item.committed)}))).label}）`, details: status.blockers.map((message) => ({message}))});
          return;
        }
        try {
          list = await commitOne(partition);
        } catch (error) {
          setActiveId(partition.id);
          if (error?.status === 410) {
            await reviewPartition(partition);
            setNotice({tone: 'warn', message: `作品「${workName(partition)}」は確かめてから時間がたったため、確認をやり直しました。見直してからもう一度登録してください`});
          } else setNotice({error, title: `作品「${workName(partition)}」を登録できませんでした（${commitProgress(list.map((item) => ({committed: Boolean(item.committed)}))).label}）`});
          return;
        }
      }
      await finishIfDone(list);
    } finally {
      setBusy(null);
      reload?.();
    }
  }

  // 手順5の登録できない理由。最初の登録の前は、すべての作品の表にエラーが無いことを求める（登録を始めると取り込まない行を変えられないため）
  const globalBlockers = [];
  if (step === 5) {
    if (controlResults.some((item) => item.invalid)) globalBlockers.push('原本の統制値が数として読めません');
    else if (controlResults.some((item) => !item.match)) globalBlockers.push('原本の統制値と合いません。原本の合計欄を確かめてください（統制値を消すと比べません）');
    if (readOnly) globalBlockers.push('設計キャンバスのプレビューでは登録できません');
  }
  const blockers = [];
  if (step === 5 && activeStatus) {
    blockers.push(...activeStatus.blockers);
    if (!progress.started) {
      const others = partitions.filter((item) => item.id !== activePartition.id && statuses.get(item.id)?.rowProblems);
      if (others.length) blockers.push(`ほかの作品の表にエラーか未確認が残っています（${others.map((item) => `「${workName(item)}」`).join('、')}）。取り込まない行は登録を始める前に決めます`);
    }
    blockers.push(...globalBlockers);
  }
  const allBlocked = globalBlockers.length > 0 || (!progress.started && partitions.some((item) => statuses.get(item.id)?.rowProblems));

  const errorRows = reviewRows.filter((row) => row.status !== 'ok');
  const gridRows = reviewRows.map((row) => ({
    key: row.key, source_row: row.sourceRow, status: row.status, status_label: row.status === 'ok' ? '取り込む' : row.status === 'warn' ? '注意' : 'エラー',
    partner_name: partners.find((item) => Number(item.id) === Number(row.values.partner_id))?.name || (row.values.partner_id ? '未登録の取引先' : '未確認'),
    product_name: row.values.product_id ? products.find((item) => Number(item.id) === Number(row.values.product_id))?.name || '未登録の商品' : '作品に直接計上',
    description: row.values.description || '報告明細', quantity: row.values.quantity, amount_ex_tax: row.values.amount_ex_tax, tax_amount: row.values.tax_amount, amount_inc_tax: row.values.amount_inc_tax,
    accounting_month: row.values.accounting_month, sales_period: periodText(row.values.sales_period_from, row.values.sales_period_to),
    reasons: row.issues.map((issue) => issue.message).join(' ／ '), issues: row.issues,
  }));
  const columns = useMemo(() => reviewColumns(), []);
  const columnTotals = useMemo(() => (step === 5 ? sourceColumnTotals(activePartition?.headers || headers, reviewRows.filter((row) => row.status === 'ok')) : []), [step, activePartition, headers, reviewRows]);
  const ignoredColumns = useMemo(() => (fields && headers.length ? buildDefinition(fields, {headers, partnerId: setup.partnerId, autoKey, resolvedProduct: splitMode}).definition.ignoredColumns.filter((column) => column !== RESOLVED_PRODUCT_COLUMN) : []), [fields, headers, setup.partnerId, autoKey, splitMode]);
  const formatSuggestion = useMemo(() => {
    if (step !== 3 || !selection) return null;
    const sample = selectionRows(selection.canonicalCsv, selection.sourceRowNumbers).slice(0, 50).map((row) => row.values);
    return suggestSalesImportFormats({headers, rows: sample});
  }, [step, selection, headers]);

  const workItems = useMemo(() => toEntityItems((works || []).map((item) => ({id: item.id, code: item.code, title: item.title}))), [works]);
  const partnerItems = useMemo(() => toEntityItems(partners.map((item) => ({id: item.id, code: item.code, name: item.name, hint: labelOf('partnerKind', item.kind)}))), [partners]);
  const basisTarget = fields ? basisDateTarget(fields) : null;
  const headerOptions = headers.map((header) => ({value: header, label: header}));

  // 報告の種類が未選択か、前の取引先の区分から自動で入れたものなら、新しい取引先の区分から選び直す
  function choosePartner(id) {
    const next = partners.find((item) => Number(item.id) === Number(id));
    const auto = !setup.kind || Boolean(kindNote);
    const guess = PARTNER_KIND_DEFAULT[next?.kind] || '';
    if (auto) setKindNote(guess ? `取引先の区分（${labelOf('partnerKind', next.kind)}）から選びました` : '');
    setSetup((previous) => ({...previous, partnerId: id, kind: auto ? guess : previous.kind}));
  }

  function jump(n) {
    setNotice(null);
    setConfirming(null);
    setStep(n);
  }

  function changeField(key, next) {
    setFields((previous) => ({...previous, [key]: next}));
    setFieldErrors((previous) => previous.filter((error) => error.target !== key));
  }

  const errorFor = (key) => fieldErrors.find((error) => error.target === key)?.message || '';
  const busyLabel = {upload: '読み込み中…', select: '表を作っています…', review: '確かめています…', assign: '作品に割り当てています…', commit: '登録しています…', result: '読み込み中…'}[busy] || '';
  const draftSpec = draft ? draftBinding(draft) : null;
  const draftChanged = Boolean(draftSpec && binding && !sameBinding(binding, draftSpec));
  const planFit = step === 4 && version ? mappingFitsBinding(version.definition, locked ? binding : draftSpec, masters) : null;
  // 手順4の割り当て（下書き）に合わせて手順3へ戻る。1つの作品へ付け替えるときは、その作品の商品で手順3の商品を選び直す
  function fixMappingForDraft() {
    const single = draft?.mode === 'single_work' && draft.workId;
    setSetup((previous) => ({...previous, assignMode: draft.mode, workId: single ? Number(draft.workId) : previous.workId}));
    if (single && fields) {
      const {field, note} = refitProductField(fields.product_id, productChoicesFor({products, allocations, kind: setup.kind, workId: draft.workId}));
      if (note) {
        setFields((previous) => ({...previous, product_id: field}));
        setNotes((previous) => ({...previous, product_id: note}));
      }
    }
    jump(3);
  }
  const planRows = (plan?.partitions || []).map((item, index) => ({
    key: item.id ?? `w${item.workId}-${index}`, work: `${workName(item)}${item.workCode ? `（${item.workCode}）` : ''}`,
    products: item.products?.length ? item.products.map((product) => `${product.name || product.sku}（${product.code}）×${product.rows}行`).join('、') : '作品に直接計上（商品を照合しない）',
    row_count: item.rowCount, amount: partitionAmountText(item.amounts, yen), state: item.committed ? '登録済み' : item.restricted ? '権限なし' : '未登録',
  }));
  const planProgress = plan?.partitions?.length ? commitProgress(plan.partitions.map((item) => ({committed: Boolean(item.committed)}))) : progress;
  const multiProducts = (plan?.partitions || []).flatMap((item) => (item.products || []).filter((product) => product.allocations.length > 1).map((product) => ({...product, placedWorkId: item.workId})));
  const sameFileRows = activeTab.overlaps?.sameFile || [];
  const committedResultIds = partitions.filter((item) => item.committed?.reportId).map((item) => item.committed.reportId);
  const result = results[resultIndex] || null;

  return (
    <div className="stack iw" aria-busy={busy ? 'true' : undefined}>
      <section className="card iw-head">
        <h2>売上報告の取込</h2>
        <p className="rp-muted">取引先から届いた報告（Excel・CSV・文字のあるPDF）を原本のまま保存し、見出し・列の対応・作品への割り当てを確かめて共通売上へ登録します。1つのファイルに複数の作品が含まれていれば、作品ごとに分けて登録できます。</p>
      </section>
      <StepBar step={step} onJump={jump} />

      {correction && step < LAST_STEP && (
        <Notice tone="warn" title="訂正版として取り込みます"
          message={`元の報告: 報告番号 ${correction.reportKey}（${correction.report?.partnerName || ''}・${kindLabel(correction.report?.kind)}・対象期間 ${periodText(correction.report?.periodFrom, correction.report?.periodTo)}・${int(correction.report?.lineCount)}件・税抜 ${yen(correction.report?.totals?.amountExTax)}）。登録すると元の報告は「訂正版あり」になり、売上明細から外れます。`}
          actions={!readOnly && step !== LAST_STEP ? <button type="button" className="text" disabled={Boolean(busy)} onClick={cancelCorrection}>訂正をやめる</button> : null} />
      )}
      {readOnly && <Notice tone="info" message="設計キャンバスのプレビューです。ファイルの読み込みと登録はできません（表示だけ）。" />}
      {notice && <Notice {...notice} onDismiss={() => setNotice(null)} />}
      {busy && <p className="rp-muted" role="status">{busyLabel}</p>}

      {step === 1 && (
        <section className="card iw-step" aria-labelledby="iw-step1">
          <h3 id="iw-step1">1. ファイルを選ぶ</h3>
          <fieldset className="iw-assign-mode" disabled={Boolean(correction) || readOnly}>
            <legend>作品の決め方</legend>
            {ASSIGN_MODES.map((option) => (
              <label key={option.value}>
                <input type="radio" name="iw-assign-mode" value={option.value} checked={setup.assignMode === option.value}
                  onChange={() => { setSetup((previous) => ({...previous, assignMode: option.value})); setOffer(null); }} />
                <span><strong>{option.label}</strong><small>{option.hint}</small></span>
              </label>
            ))}
            {correction && <p className="rp-muted">訂正版は、元の報告と同じ1つの作品に取り込みます。</p>}
          </fieldset>
          <div className="on-form-grid">
            {!splitMode && (
              <EntityPicker label="作品" required items={workItems} value={setup.workId} disabled={Boolean(correction) || readOnly}
                emptyText="売上を取り込める作品がありません" onChange={(id) => { setSetup((previous) => ({...previous, workId: id})); resetFrom(1); }} />
            )}
            <EntityPicker label="取引先" required items={partnerItems} value={setup.partnerId} disabled={Boolean(correction) || readOnly || Boolean(source?.commitTerms)} onChange={choosePartner} />
            <FormField type="select" label="報告の種類" required value={setup.kind} disabled={Boolean(correction) || readOnly || Boolean(source?.commitTerms)}
              options={KINDS.map((value) => ({value, label: kindLabel(value)}))} hint={kindNote || '配信・ビデオグラム・劇場などの区別。列の対応は取引先×報告の種類ごとに版を持ちます'}
              onChange={(value) => { setKindNote(''); setSetup((previous) => ({...previous, kind: value})); }} />
          </div>
          {setup.partnerId && <PreviousImports context={context} partnerName={partner?.name} />}
          <div className={`iw-drop${busy === 'upload' ? ' is-busy' : ''}${readOnly ? ' is-disabled' : ''}`} ref={dropRef}
            onDragOver={(event) => { event.preventDefault(); dropRef.current?.classList.add('is-over'); }}
            onDragLeave={() => dropRef.current?.classList.remove('is-over')}
            onDrop={(event) => { event.preventDefault(); dropRef.current?.classList.remove('is-over'); if (!readOnly) pickFile(event.dataTransfer.files?.[0]); }}>
            <label>
              <input type="file" accept=".xlsx,.csv,.txt,.pdf" disabled={readOnly || Boolean(busy)} onChange={(event) => { pickFile(event.target.files?.[0]); event.target.value = ''; }} />
              <span>{file ? '別のファイルにするときは、ここへドラッグするか押して選びます' : 'Excel（.xlsx）・CSV・文字のあるPDF をここへドラッグ、または押して選ぶ'}</span>
            </label>
          </div>
          {file && (
            <p className="iw-file"><strong>{file.name}</strong>（{file.kindLabel}・{fileSizeText(file.size)}{file.encoding ? `・文字コード ${file.encoding}` : ''}）</p>
          )}
          {limits && <p className="rp-muted">1回の登録（作品ごとの報告1件）に取り込めるのは{int(limits.salesRows)}行まで。作品ごとに分ける原本は全体で{int(limits.sourceRows ?? limits.salesRows)}行まで（{limits.reason}）。ファイルは6MBまで。</p>}
          {offer && <RebindOffer offer={offer} onChange={setOffer} onRebind={() => acceptOffer(true)} onKeep={() => acceptOffer(false)} onCancel={() => setOffer(null)} busy={Boolean(busy)} readOnly={readOnly} />}
          {(context?.sourceFiles?.length > 0 || context?.pending?.length > 0) && (
            <details className="iw-pending">
              <summary>{pendingListTitle({shown: (context.sourceFiles?.length || 0) + (context.pending?.length || 0), total: (context.sourceFilesTotal ?? context.sourceFiles?.length ?? 0) + (context.pendingTotal ?? context.pending?.length ?? 0)})}</summary>
              <ul>
                {(context.sourceFiles || []).map((row) => (
                  <li key={`f${row.fileId}`}>
                    {row.fileName}（{dateTimeJst(row.createdAt)}・{bindingText(row.binding ? {...row.binding} : null, row.binding?.workTitle ? [{id: row.binding.workId, title: row.binding.workTitle}] : [])}・{row.progressLabel}）
                    <button type="button" className="text" disabled={readOnly || Boolean(busy) || !setup.partnerId || !setup.kind} onClick={() => resumeFile(row.fileId)}>続きから取り込む</button>
                  </li>
                ))}
                {(context.pending || []).map((row) => (
                  <li key={`a${row.artifactId}`}>
                    {row.fileName}（{dateTimeJst(row.createdAt)}・旧方式の原本。続けると新しい取込に引き継ぎます）
                    <button type="button" className="text" disabled={readOnly || Boolean(busy) || !setup.partnerId || !setup.kind} onClick={() => resumeLegacy(row.artifactId)}>続きから取り込む</button>
                  </li>
                ))}
              </ul>
              {(!setup.partnerId || !setup.kind) && <p className="rp-muted">続きから取り込むときも、取引先と報告の種類を先に選びます。</p>}
            </details>
          )}
          <ActionBar>
            {file && <p className="rp-muted">{splitMode ? '「次へ」で、このファイルを作品を決めずに原本として保存します。作品への割り当ては手順4で行います。' : `「次へ」で、このファイルは作品「${work?.title || '選んだ作品'}」の原本として保存されます。登録の前なら、手順4で別の作品に付け替えられます（理由を記録します）。`}</p>}
            <button type="button" disabled={readOnly || Boolean(busy) || !file || (!splitMode && !setup.workId) || !setup.partnerId || !setup.kind} onClick={startFromFile}>
              {busy === 'upload' ? '読み込み中…' : splitMode ? '次へ（原本として保存）' : `次へ（「${work?.title || '選んだ作品'}」の原本として保存）`}
            </button>
          </ActionBar>
          <details className="iw-legacy" onToggle={(event) => setLegacyOpen(event.currentTarget.open)}>
            <summary>詳細モード（従来の画面）</summary>
            <p className="rp-muted">列対応を元の列名で直接書く、AIの候補を使うなど、従来の手順で取り込みます（1つの作品の報告だけ。作品の付け替え・分割はできません）。</p>
            {legacyOpen && !readOnly && <RawReportWorkflow data={{...data, selectedWorkId: Number(setup.workId) || data?.selectedWorkId}} request={request} reload={reload} />}
          </details>
        </section>
      )}

      {step === 2 && sheet && (
        <section className="card iw-step" aria-labelledby="iw-step2">
          <h3 id="iw-step2">2. 見出しを確かめる</h3>
          <p className="iw-file"><strong>{source.fileName}</strong>{file?.encoding ? `（文字コード ${file.encoding}）` : ''}</p>
          {source.locked && <Notice tone="info" compact message="登録を始めた原本なので、見出しの行と取り込まない行は変えられません（保存した表の選択を使います）。" />}
          {source.commitTerms && <Notice tone="info" compact message={`この原本は、取引先「${source.commitTerms.partnerName || source.commitTerms.partnerId}」・報告の種類「${kindLabel(source.commitTerms.kind)}」の報告として登録を始めています。残りの作品も同じ取引先・報告の種類で登録します（列対応は版${source.commitTerms.mappingVersionNo ?? '—'}で登録しました）。`} />}
          {sheets.length > 1 && (
            <FormField type="select" label="シート" value={sheet.name} includeBlank={false} options={sheets.map((item) => ({value: item.name, label: item.name}))} disabled={source.locked}
              onChange={(value) => { const next = sheets.find((item) => item.name === value); setSheetName(value); setHeaderRow(next ? detectHeaderRow(next.rows).row : null); setHeaderManual(false); resetFrom(2); }} />
          )}
          {headerManual
            ? <Notice tone="info" compact message={`見出し: ${headerRow}行目（${source.locked ? '保存した選択' : '手で選びました'}）`} actions={detection?.row && !source.locked ? <button type="button" className="text" onClick={() => { setHeaderRow(detection.row); setHeaderManual(false); resetFrom(2); }}>推定（{detection.row}行目）に戻す</button> : null} />
            : detection?.row
              ? <Notice tone={detection.confidence === 'low' ? 'warn' : 'info'} compact message={`見出しは${detection.row}行目と推定しました（${CONFIDENCE_LABELS[detection.confidence]}）: ${detection.reasons.join('、')}`} />
              : <Notice tone="warn" compact message="見出しの行を推定できませんでした。見出しの行を押して選んでください" />}
          {headerIssues.length > 0 && <Notice tone="error" compact title="この行は見出しに使えません" details={headerIssues.map((item) => ({column: item.column, message: item.message}))} />}
          {totalRows.length > 0 && <Notice tone="warn" compact message={`合計行の可能性がある行: ${totalRows.map((item) => `${item.row}行目`).join('、')}。手順5で「取り込まない行」にできます`} />}
          <HeaderTable sheet={sheet} headerRow={headerRow} totalRows={totalRows} disabled={Boolean(busy) || source.locked} onChoose={(row) => { setHeaderRow(row); setHeaderManual(row !== detection?.row); resetFrom(2); }} />
          {(sheet.rows || []).length > PREVIEW_ROWS && !source.locked && (
            <div className="iw-inline">
              <FormField type="int" label="31行目より下を見出しにするとき（行番号）" value={headerRow && headerRow > PREVIEW_ROWS ? String(headerRow) : ''} showPreview={false}
                onChange={(value) => { const n = Number(String(value).replace(/[^0-9]/g, '')); if (n >= 1 && n <= sheet.rows.length) { setHeaderRow(n); setHeaderManual(true); resetFrom(2); } }} />
            </div>
          )}
          {exclusions.length > 0 && <p className="rp-muted">取り込まない行: {exclusions.map((row) => `${row.sourceRow}行目`).join('、')}（手順5で見直せます）</p>}
          {selectionProblem && (
            <Notice error={selectionProblem.error} title="この見出しでは表を作れません"
              actions={selectionProblem.rows.length ? <button type="button" className="secondary" onClick={excludeProblemRows}>これらの行を取り込まない行にする</button> : null} />
          )}
          <ActionBar>
            <button type="button" className="secondary" disabled={Boolean(busy)} onClick={() => jump(1)}>戻る</button>
            <button type="button" disabled={Boolean(busy) || readOnly || !headerRow || headerIssues.length > 0} onClick={confirmHeader}>{busy === 'select' ? '表を作っています…' : '次へ（列を対応づける）'}</button>
          </ActionBar>
        </section>
      )}

      {step === 3 && fields && (
        <section className="card iw-step" aria-labelledby="iw-step3">
          <h3 id="iw-step3">3. 列を対応づける</h3>
          <p className="rp-muted">左の共通の列に、元の報告のどの列を使うかを選びます。候補は{context?.mapping ? `前回の列対応（版${context.mapping.versionNo}）と` : ''}見出しの名前から入れています。保存すると列対応の新しい版（変更できない記録）になります。</p>
          {splitMode && <Notice tone="info" compact message={setup.assignMode === 'by_product' ? '商品コードの列で作品ごとに分けるので、商品は「行ごとに商品コードで照合する」にします（照合した商品は手順4で確かめます）。' : '作品コードの列で作品ごとに分けます。商品も行ごとに照合するときは「行ごとに商品コードで照合する」を選び、手順4で商品コードの列を選びます。'} />}
          {formatSuggestion?.recommended && formatSuggestion.recommended !== setup.kind && (
            <Notice tone="warn" compact message={`見出しから見ると「${kindLabel(formatSuggestion.recommended)}」の報告のようです（根拠: ${formatSuggestion.candidates[0].evidence.map((item) => item.signal).join('・')}）。報告の種類「${kindLabel(setup.kind)}」で合っているか確かめてください`} />
          )}
          <div className="iw-map-wrap">
            <table className="iw-map">
              <thead><tr><th scope="col">共通の列</th><th scope="col">元の列・値</th><th scope="col">候補の理由</th></tr></thead>
              <tbody>
                <tr>
                  <th scope="row">取引先<span className="on-req">必須</span></th>
                  <td><p className="iw-fixed">{partner?.name || '未確認'}（手順1で選んだ取引先）</p></td>
                  <td className="iw-note" />
                </tr>
                {FIELD_SPECS.filter((spec) => (spec.basisOnly ? fields.recognition_basis_id?.mode === 'literal' : spec.noBasisOnly ? fields.recognition_basis_id?.mode === 'none' : true)).map((spec) => (
                  <MappingRow key={spec.key} spec={spec} field={fields[spec.key] || blankField('')} note={notes[spec.key]} error={errorFor(spec.key)} headers={headers}
                    onChange={(next) => changeField(spec.key, next)} products={productChoices} bases={bases} basisTarget={basisTarget}
                    correction={correction} autoKey={autoKey} disabled={Boolean(busy) || readOnly} resolvedAllowed={splitMode} />
                ))}
              </tbody>
            </table>
          </div>
          <details className="iw-attributes" open={Boolean(fields.attributes && Object.keys(fields.attributes).length)}>
            <summary>売上集計シートの列（任意・{int(Object.keys(fields.attributes || {}).length)}列を使う）</summary>
            <p className="rp-muted">劇場名・券種・延滞・視聴UU数など、報告にあって共通の列に無い項目を、売上集計シート（83列）の拡張属性として売上と一緒に登録します。使わない列は「使わない」のまま。見出しが一致する列だけを初めから選び、似た見出しは候補として下に示します。</p>
            {attributeColumns.length === 0 && <p className="rp-muted">この組織は売上集計シートの拡張属性の列を使っていません（管理者が帳票センターの売上集計シートで列を採用すると選べます）。</p>}
            <div className="iw-attr-grid">
              {attributeColumns.map((target) => (
                <FormField key={target.key} type="select" label={target.label.replace('（売上集計シート）', '')} value={fields.attributes?.[target.key] || ''} blankLabel="使わない"
                  options={headers.map((header) => ({value: header, label: header}))} hint={notes[target.key]} error={errorFor(target.key)} disabled={Boolean(busy) || readOnly}
                  onChange={(value) => setFields((previous) => {
                    const next = {...(previous.attributes || {})};
                    if (value) next[target.key] = value; else delete next[target.key];
                    return {...previous, attributes: next};
                  })} />
              ))}
            </div>
          </details>
          {!splitMode && productChoices.length === 0 && <p className="rp-muted">この作品に結び付いた「{kindLabel(setup.kind)}」の商品がありません。商品を使わずに作品へ直接計上します（商品は作品商品マスタで結び付けられます）。</p>}
          <p className="iw-ignored"><strong>取り込まない列</strong>（{int(ignoredColumns.length)}列）: {ignoredColumns.join('、') || 'なし'}</p>
          <h4>検算（任意）</h4>
          <ChecksEditor checks={checks} headers={headers} onChange={(next) => setChecks(next)} disabled={Boolean(busy) || readOnly} />
          <ActionBar>
            <button type="button" className="secondary" disabled={Boolean(busy)} onClick={() => jump(2)}>戻る</button>
            <button type="button" disabled={Boolean(busy) || readOnly} onClick={saveMappingAndAssign}>{busy === 'review' ? '保存しています…' : 'この対応で保存して、作品に割り当てる'}</button>
          </ActionBar>
        </section>
      )}

      {step === 4 && draft && (
        <section className="card iw-step" aria-labelledby="iw-step4">
          <h3 id="iw-step4">4. 作品・商品に割り当てる</h3>
          <p className="rp-muted">報告の行をどの作品の売上にするかを決めます。作品ごとに報告を分け、次の手順で作品ごとに確かめて登録します。照らし合わせられない値は推測で埋めません。</p>
          <div className="iw-binding">
            <p><strong>今の割り当て</strong>: {binding ? `${bindingText(binding, works || [])}（版${binding.versionNo}・${binding.reason}）` : 'まだ決めていません'}</p>
            {locked && <Notice tone="info" compact message={`登録を始めた（${planProgress.started ? planProgress.label : '登録済みの作品があります'}）ため、付け替え・分け方の変更はできません。残りの作品を登録します。`} />}
            {binding && !draft.editing && !correction && (
              <button type="button" className="secondary" disabled={Boolean(busy) || readOnly || locked} title={locked ? '登録を始めた原本は付け替えられません' : undefined}
                onClick={() => setDraft((previous) => ({...previous, editing: true}))}>作品の決め方を付け替える</button>
            )}
          </div>
          {!locked && (draft.editing || !binding) && (
            <fieldset className="iw-assign-mode" disabled={Boolean(busy) || readOnly || Boolean(correction)}>
              <legend>作品の決め方{binding ? '（付け替え）' : ''}</legend>
              {ASSIGN_MODES.map((option) => (
                <label key={option.value}>
                  <input type="radio" name="iw-draft-mode" value={option.value} checked={draft.mode === option.value}
                    onChange={() => changeDraft({mode: option.value, useProductColumn: option.value === 'by_product' || (option.value === 'by_work_column' && fields?.product_id?.mode === 'resolved')})} />
                  <span><strong>{option.label}</strong><small>{option.hint}</small></span>
                </label>
              ))}
              <div className="on-form-grid">
                {draft.mode === 'single_work' && <EntityPicker label="作品" required items={workItems} value={draft.workId} onChange={(id) => changeDraft({workId: id})} />}
                {draft.mode === 'by_work_column' && <FormField type="select" label="作品コードの列" required value={draft.workColumn} options={headerOptions} onChange={(value) => changeDraft({workColumn: value})} />}
                {(draft.mode === 'by_product' || (draft.mode === 'by_work_column' && draft.useProductColumn)) && (
                  <FormField type="select" label="商品コードの列" required value={draft.productColumn} options={headerOptions} onChange={(value) => changeDraft({productColumn: value})}
                    hint={draft.mode === 'by_product' ? '作品商品マスタの商品コードと照らし、その商品の配賦先の作品に割り当てます' : '作品コードで決めた作品に、その商品が配賦されているかも確かめます'} />
                )}
              </div>
              {draft.mode === 'by_work_column' && (
                <label className="iw-inline-check"><input type="checkbox" checked={draft.useProductColumn} onChange={(event) => changeDraft({useProductColumn: event.target.checked})} /> 商品も行ごとに照合する</label>
              )}
              {binding && draftChanged && (
                <FormField type="textarea" label="付け替える理由" required rows={2} maxLength={500} value={draft.reason} placeholder="例: 2作品分の報告が1ファイルで届いたため、商品コードで作品ごとに分ける"
                  onChange={(value) => setDraft((previous) => ({...previous, reason: value}))} hint="理由と前後の割り当ては記録に残ります。登録を始めると付け替えられません" />
              )}
              {binding && draft.editing && (
                <button type="button" className="text" onClick={() => { const reset = draftFrom(binding, selection); setDraft(reset); runPlan(reset); }}>付け替えをやめる</button>
              )}
            </fieldset>
          )}
          {planFit && <Notice tone="warn" compact message={planFit} actions={<button type="button" className="text" onClick={fixMappingForDraft}>手順3で列の対応を直す</button>} />}
          {planError && <Notice error={planError} title="割り当てを試せませんでした" />}
          {!plan && !planError && !locked && <p className="rp-muted">作品の決め方を最後まで選ぶと、作品ごとの行数と金額を出します。</p>}
          {plan && (
            <>
              <p>{`全${int(plan.summary.rows)}行のうち${int(plan.summary.matched)}行を${int(plan.summary.works)}作品に割り当てます。`}{plan.summary.unmatched ? `割り当てられない行が${int(plan.summary.unmatched)}行あります。` : ''}</p>
              {plan.errors?.length > 0 && <Notice tone="error" details={plan.errors.map((message) => ({message}))} />}
              {plan.restrictedCount > 0 && <Notice tone="error" message={`権限のない作品（${plan.restrictedCount}作品）に割り当たる行、または配賦された商品があります。管理者に確認してください（作品名は表示しません）。`} />}
              <DataGrid columns={assignmentColumns()} rows={planRows} rowKey="key" emptyText="割り当てた行がありません" ariaLabel="作品ごとの割り当て"
                exportSpec={{name: '作品ごとの割り当て', title: '作品ごとの割り当て', conditions: [['原本', source?.fileName || ''], ['割り当て', bindingText(locked ? binding : draftSpec, works || [])]], dataAsOf: new Date().toISOString()}} />
              {multiProducts.length > 0 && (
                <div className="iw-multi">
                  <h4>複数の作品に配賦された商品</h4>
                  <p className="rp-muted">報告はどれか1つの作品に置き、ほかの作品への按分は今までどおり集計のときに配賦率で行います。初めは配賦率が最も高い作品に置いています。</p>
                  {multiProducts.map((product) => (
                    <FormField key={product.productId} type="select" label={`「${product.name || product.sku}」（${product.code}）の報告を置く作品`} includeBlank={false} disabled={locked || Boolean(busy) || readOnly}
                      value={String(product.placedWorkId)} options={product.allocations.map((share) => ({value: String(share.workId), label: `${share.workTitle || '権限のない作品'}（配賦 ${(share.bps / 100).toFixed(2)}%）`}))}
                      onChange={(value) => chooseReportWork(product.productId, value)} />
                  ))}
                </div>
              )}
              {plan.unmatched?.length > 0 && (
                <div className="iw-exclude">
                  <h4>割り当てられない行（{plan.unmatched.length}行）</h4>
                  <p className="rp-muted">作品・商品のマスタにない、または配賦が決まっていない値です。推測では割り当てません。作品商品マスタを直してからもう一度確かめるか、理由を書いて取り込まない行にします。</p>
                  <table className="iw-mini">
                    <thead><tr><th scope="col" className="num">原本の行</th><th scope="col">列</th><th scope="col">値</th><th scope="col">理由</th><th scope="col">取り込まない（理由）</th></tr></thead>
                    <tbody>{plan.unmatched.map((row) => {
                      const mark = unmatchedMarks[row.sourceRow] || {checked: false, reason: `割り当てられない: ${row.reason}`.slice(0, 200)};
                      return (
                        <tr key={row.sourceRow}>
                          <td className="num">{row.sourceRow}</td><td>{row.column}</td><td>{row.value || '（空欄）'}</td><td>{row.reason}</td>
                          <td>
                            <label className="iw-exclude-check"><input type="checkbox" checked={mark.checked} disabled={Boolean(busy) || readOnly} onChange={(event) => setUnmatchedMarks((previous) => ({...previous, [row.sourceRow]: {...mark, checked: event.target.checked}}))} /> 取り込まない</label>
                            {mark.checked && <input type="text" aria-label={`${row.sourceRow}行目を取り込まない理由`} maxLength={200} value={mark.reason} onChange={(event) => setUnmatchedMarks((previous) => ({...previous, [row.sourceRow]: {...mark, reason: event.target.value}}))} />}
                          </td>
                        </tr>
                      );
                    })}</tbody>
                  </table>
                  <div className="on-form-actions">
                    <button type="button" className="secondary" disabled={Boolean(busy) || readOnly || !Object.values(unmatchedMarks).some((mark) => mark.checked)} onClick={excludeUnmatched}>選んだ行を取り込まない行にして分け直す</button>
                    <button type="button" className="text" onClick={() => navigate('作品・商品マスタ')}>作品商品マスタを開く</button>
                    <button type="button" className="text" disabled={Boolean(busy)} onClick={() => runPlan()}>マスタを直したので、もう一度照らす</button>
                  </div>
                </div>
              )}
            </>
          )}
          <ActionBar>
            <button type="button" className="secondary" disabled={Boolean(busy)} onClick={() => jump(3)}>戻る（列の対応）</button>
            <button type="button" disabled={Boolean(busy) || readOnly || Boolean(planFit) || (!locked && (!draftSpec || (binding && draftChanged && !draft.reason.trim())))} onClick={confirmAssignment}>
              {busy === 'assign' ? '割り当てています…' : `${draftChanged ? '付け替えて、' : ''}この割り当てで作品ごとに確かめる${plan?.summary?.works ? `（${plan.summary.works}作品）` : ''}`}
            </button>
          </ActionBar>
        </section>
      )}

      {step === 5 && selection && version && activePartition && (
        <section className="card iw-step" aria-labelledby="iw-step5">
          <h3 id="iw-step5">5. 表で確かめる</h3>
          <p className="rp-muted">共通売上に登録する内容です（列対応 版{version.versionNo}{binding ? `・作品の割り当て 版${binding.versionNo}` : ''}）。エラーの行は赤で理由を出します。エラーが残る間は登録できません。</p>
          {partitions.length > 1 && (
            <>
              <Notice tone={progress.started ? 'info' : 'info'} compact title={`1つの原本を${partitions.length}作品に分けました（${progress.label}）`}
                message="作品ごとに1件の報告として登録します。作品を順に確かめて登録するか、下の「まだの作品をすべて順番に登録する」を使います。登録を始めると、取り込まない行・割り当ては変えられません。" />
              <Tabs label="作品ごとの表" value={activePartition.id} onChange={(id) => { setActiveId(id); setConfirming(null); }}
                tabs={partitions.map((item) => {
                  const status = statuses.get(item.id);
                  return {id: item.id, label: workName(item), badge: item.committed ? '登録済み' : status?.totals.errors ? `エラー${status.totals.errors}` : status?.blockers.length ? '要確認' : '確認済み'};
                })} />
            </>
          )}
          {activePartition.committed && <Notice tone="ok" compact message={`作品「${workName(activePartition)}」は登録済みです。`} actions={activePartition.committed.reportId ? <button type="button" className="text" onClick={() => openResults([activePartition.committed.reportId])}>登録結果を見る</button> : null} />}
          <div className="rp-tiles">
            {partitions.length > 1 && <div><span>作品</span><strong>{workName(activePartition)}</strong></div>}
            <div><span>取り込む行</span><strong>{int(totals.count)}件</strong></div>
            <div><span>税抜</span><strong>{yen(totals.amount_ex_tax)}</strong></div>
            <div><span>税額</span><strong>{yen(totals.tax_amount)}</strong></div>
            <div><span>税込</span><strong>{yen(totals.amount_inc_tax)}</strong></div>
            <div className={totals.errors ? 'iw-tile-bad' : undefined}><span>エラーの行</span><strong>{int(totals.errors)}件</strong></div>
            <div><span>取り込まない行（原本全体）</span><strong>{int(exclusions.length)}件</strong></div>
          </div>
          {totals.observations > 0 && <p className="rp-muted">在庫などの観測値だけの行が{int(totals.observations)}行あります（売上には数えず、報告の観測値として登録します）。</p>}
          {activeTab.previewError && <Notice error={activeTab.previewError} message={friendlyMessage(activeTab.previewError.message)} title="確認できませんでした" />}
          {activeStatus.reportErrors.length > 0 && <Notice tone="error" title="報告全体の問題" details={activeStatus.reportErrors.map((message) => ({message}))} />}

          {!activePartition.committed && activeTab.overlaps && overlapRows.length > 0 && (
            <div className="iw-overlap" role="group" aria-labelledby="iw-overlap-title">
              <Notice tone={activeStatus.overlapProblem ? 'warn' : 'info'} title="同じ取引先・報告の種類で、対象期間が重なる報告が登録済みです"
                message={activeStatus.overlapProblem ? '二重に取り込んでいないか確かめてください。訂正版か別の報告かを選ぶまで登録しません。' : correction ? '訂正版として取り込み、元の報告を置き換えます。' : '別の報告として、理由とともに取り込みます。'} />
              <table className="iw-mini">
                <thead><tr><th scope="col">報告番号</th><th scope="col">対象期間</th><th scope="col">計上月</th><th scope="col" className="num">件数</th><th scope="col" className="num">税抜</th><th scope="col">登録日時</th></tr></thead>
                <tbody>{overlapRows.map((row) => (
                  <tr key={row.id}><td>{row.reportKey}</td><td>{periodText(row.periodFrom, row.periodTo)}</td><td>{monthText(row.accountingMonth)}</td><td className="num">{int(row.lineCount)}</td><td className="num">{int(row.totals.amountExTax)}</td><td>{dateTimeJst(row.createdAt)}</td></tr>
                ))}</tbody>
              </table>
              <h4 id="iw-overlap-title">この報告の扱い</h4>
              {correction
                ? <p>訂正版として取り込みます（元の報告: 報告番号 {correction.reportKey}）。</p>
                : (
                  <div className="iw-radios">
                    <label><input type="radio" name={`iw-decision-${activePartition.id}`} checked={decision.mode === 'supersede'} onChange={() => setDecision((previous) => ({...previous, mode: 'supersede', targetId: previous.targetId || String(overlapRows[0].id)}))} /> 訂正版として取り込む（元の報告を選ぶ）</label>
                    {decision.mode === 'supersede' && (
                      <div className="iw-inline">
                        <FormField type="select" label="訂正する元の報告" value={decision.targetId} includeBlank={false}
                          options={overlapRows.map((row) => ({value: String(row.id), label: `${row.reportKey}（${periodText(row.periodFrom, row.periodTo)}・${int(row.lineCount)}件）`}))}
                          onChange={(value) => setDecision((previous) => ({...previous, targetId: value}))} />
                        <button type="button" className="secondary" disabled={Boolean(busy) || readOnly || partitions.length > 1} onClick={() => applyCorrection(overlapRows.find((row) => String(row.id) === String(decision.targetId)))}>この報告の訂正版として確かめ直す</button>
                        {partitions.length > 1 && <p className="rp-muted">作品ごとに分けた原本は、訂正版として取り込めません（訂正は元の報告と同じ1つの作品の原本で行います）。</p>}
                      </div>
                    )}
                    <label><input type="radio" name={`iw-decision-${activePartition.id}`} checked={decision.mode === 'separate'} onChange={() => setDecision((previous) => ({...previous, mode: 'separate'}))} /> 別の報告として取り込む（理由が必要）</label>
                  </div>
                )}
              {(decision.mode === 'separate' || (correction && overlapRows.some((row) => Number(row.id) !== Number(correction.id)))) && (
                <FormField type="textarea" label={correction ? 'ほかにも重なる報告があります。取り込む理由' : '別の報告として取り込む理由'} required rows={2} maxLength={500} value={decision.reason}
                  placeholder="例: 同じ月の追加分の報告を別に受け取ったため" onChange={(value) => setDecision((previous) => ({...previous, reason: value}))} />
              )}
            </div>
          )}
          {sameFileRows.length > 0 && <Notice tone="info" compact message={`同じ原本の別の作品の分として、${sameFileRows.length}件を登録済みです（${sameFileRows.map((row) => `「${row.workTitle}」${row.reportKey}`).join('、')}）。重複ではありません`} />}
          {activeTab.overlaps?.otherWorks?.length > 0 && <Notice tone="info" compact message={`ほかの作品にも、同じ取引先・報告の種類・期間の報告が${activeTab.overlaps.otherWorks.length}件あります（${activeTab.overlaps.otherWorks.map((row) => `「${row.workTitle}」${row.reportKey}`).join('、')}）。作品の選び間違いでないか確かめてください`} />}

          <DataGrid columns={columns} rows={gridRows} rowKey="key" showTotals={false} emptyText="取り込む行がありません" maxHeight="55vh" ariaLabel={`登録する売上（確認用・作品「${workName(activePartition)}」）`}
            exportSpec={{name: '売上取込の確認', title: '売上取込の確認', period: fields?.period_from?.value ? `${fields.period_from.value}〜${fields.period_to.value}` : '', conditions: [['取引先', partner?.name || ''], ['報告の種類', kindLabel(setup.kind)], ['作品', workName(activePartition)], ['原本', source?.fileName || '']], dataAsOf: new Date().toISOString()}} />

          {errorRows.length > 0 && !activePartition.committed && (
            <div className="iw-exclude">
              <h4>エラー・注意のある行（{errorRows.length}行）</h4>
              <p className="rp-muted">{locked ? '登録を始めた原本は、取り込まない行を変えられません。作品商品マスタなどを直してから「もう一度確かめる」を押してください。' : '元のファイルを直して読み込み直すか、取り込まない行にします（理由は必須。除いた行番号・理由・金額は登録結果と記録に残ります。取り込まない行は原本全体に効きます）。'}</p>
              <ul>
                {errorRows.map((row) => {
                  const mark = marks[row.sourceRow] || {checked: false, reason: defaultExclusionReason(row)};
                  const onlyTotal = row.status === 'warn';
                  return (
                    <li key={row.sourceRow} className={row.status === 'error' ? 'is-error' : 'is-warn'}>
                      <label className="iw-exclude-check">
                        <input type="checkbox" checked={mark.checked} disabled={Boolean(busy) || readOnly || locked} onChange={(event) => setMarks((previous) => ({...previous, [row.sourceRow]: {...mark, checked: event.target.checked}}))} />
                        {row.sourceRow}行目を取り込まない
                      </label>
                      <span className="iw-exclude-why">{row.issues.map((issue) => issue.message).join(' ／ ')}</span>
                      {mark.checked && <input type="text" aria-label={`${row.sourceRow}行目を取り込まない理由`} maxLength={200} value={mark.reason} onChange={(event) => setMarks((previous) => ({...previous, [row.sourceRow]: {...mark, reason: event.target.value}}))} />}
                      {onlyTotal && !mark.checked && <button type="button" className="text" onClick={() => setAcceptedRows((previous) => [...previous, row.sourceRow])}>合計行ではない（明細として取り込む）</button>}
                    </li>
                  );
                })}
              </ul>
              <div className="on-form-actions">
                <button type="button" className="secondary" disabled={Boolean(busy) || readOnly || locked || !Object.values(marks).some((mark) => mark.checked)} onClick={applyExclusions}>選んだ行を除いて、もう一度確かめる</button>
                <button type="button" className="text" onClick={downloadFailedRows}>エラーの行をExcelで保存（元の列＋理由）</button>
              </div>
            </div>
          )}
          {!locked && (
            <details className="iw-more">
              <summary>ほかの行も取り込まない行にする</summary>
              <div className="iw-inline">
                <FormField type="int" label="原本の行番号" value={extraExclusion.row} showPreview={false} onChange={(value) => setExtraExclusion((previous) => ({...previous, row: String(value).replace(/[^0-9]/g, '')}))} />
                <FormField type="text" label="取り込まない理由" required value={extraExclusion.reason} maxLength={200} onChange={(value) => setExtraExclusion((previous) => ({...previous, reason: value}))} />
                <button type="button" className="secondary" disabled={Boolean(busy) || readOnly || !extraExclusion.row} onClick={applyExclusions}>この行を除いて確かめる</button>
              </div>
            </details>
          )}
          {exclusions.length > 0 && (
            <div className="iw-excluded">
              <h4>取り込まない行（原本全体で{exclusions.length}行）</h4>
              <table className="iw-mini">
                <thead><tr><th scope="col" className="num">原本の行</th><th scope="col">理由</th><th scope="col" className="num">税抜</th><th scope="col" className="num">税込</th><th scope="col"><span className="dg-vh">操作</span></th></tr></thead>
                <tbody>{exclusions.map((row) => (
                  <tr key={row.sourceRow}><td className="num">{row.sourceRow}</td><td>{row.reason}</td><td className="num">{row.amountExTax == null ? '未確認' : int(row.amountExTax)}</td><td className="num">{row.amountIncTax == null ? '未確認' : int(row.amountIncTax)}</td>
                    <td>{!locked && <button type="button" className="text" disabled={Boolean(busy) || readOnly} onClick={() => restoreExclusion(row.sourceRow)}>取り込む行に戻す</button>}</td></tr>
                ))}</tbody>
              </table>
            </div>
          )}

          <div className="iw-controls">
            <h4>原本の統制値と照らし合わせる（任意）</h4>
            <p className="rp-muted">報告の合計欄にある件数・金額を入れると、取り込む内容{partitions.length > 1 ? '（すべての作品の合計）' : ''}と比べます。</p>
            <div className="on-form-grid">
              <FormField type="int" label="件数" value={controls.rowCount} onChange={(value) => setControls((previous) => ({...previous, rowCount: value}))} />
              <FormField type="yen" label="税抜の合計" allowNegative value={controls.amountExTax} onChange={(value) => setControls((previous) => ({...previous, amountExTax: value}))} />
              <FormField type="yen" label="税込の合計" allowNegative value={controls.amountIncTax} onChange={(value) => setControls((previous) => ({...previous, amountIncTax: value}))} />
            </div>
            {controlResults.length > 0 && (
              <ul className="iw-compare">
                {controlResults.map((item) => (
                  <li key={item.key} className={`rp-check ${item.match ? 'is-ok' : 'is-bad'}`}>
                    {item.label}: {item.invalid ? '数として読めません' : item.match ? `一致（${int(item.actual)}）` : `不一致（原本 ${int(item.expected)}・取込 ${int(item.actual)}・差 ${int(item.difference)}）`}
                  </li>
                ))}
              </ul>
            )}
            {columnTotals.length > 0 && (
              <details>
                <summary>取り込む行の、元の列の合計{partitions.length > 1 ? '（この作品）' : ''}</summary>
                <table className="iw-mini">
                  <thead><tr><th scope="col">元の列</th><th scope="col" className="num">合計</th><th scope="col" className="num">値のある行</th></tr></thead>
                  <tbody>{columnTotals.map((item) => <tr key={item.column}><td>{item.column}</td><td className="num">{int(item.total)}</td><td className="num">{int(item.count)}</td></tr>)}</tbody>
                </table>
              </details>
            )}
          </div>

          {!activePartition.committed && blockers.length > 0 && <Notice tone="warn" title="登録の前に" details={blockers.map((message) => ({message}))} />}
          {confirming === 'one' && blockers.length === 0 && (
            <div className="iw-confirm" role="group" aria-label="登録の確認">
              <p><strong>{int(totals.count)}件・税抜 {yen(totals.amount_ex_tax)}・税額 {yen(totals.tax_amount)}・税込 {yen(totals.amount_inc_tax)}</strong> を、{partner?.name}の{kindLabel(setup.kind)}の報告（作品「{workName(activePartition)}」）として登録します。
                {correction ? ` 元の報告（報告番号 ${correction.reportKey}）は訂正版で置き換わります。` : ''}{exclusions.length ? ` 取り込まない行${exclusions.length}行は理由とともに記録します。` : ''}{partitions.length > 1 && !progress.started ? ' 登録を始めると、ほかの作品の割り当てと取り込まない行は変えられません。' : ''} 登録した報告は消せません（直すときは訂正版を取り込みます）。</p>
              <div className="on-form-actions">
                <button type="button" disabled={Boolean(busy)} onClick={commitActive}>{busy === 'commit' ? '登録しています…' : partitions.length > 1 ? 'この作品を登録する' : 'この内容で登録する'}</button>
                <button type="button" className="secondary" disabled={Boolean(busy)} onClick={() => setConfirming(null)}>戻って直す</button>
              </div>
            </div>
          )}
          {confirming === 'all' && (
            <div className="iw-confirm" role="group" aria-label="まとめて登録の確認">
              <p>まだの{progress.remaining}作品を順番に登録します（合計 {int(partitions.filter((item) => !item.committed).reduce((sum, item) => sum + (statuses.get(item.id)?.totals.count || 0), 0))}件・税抜 {yen(partitions.filter((item) => !item.committed).reduce((sum, item) => sum + (statuses.get(item.id)?.totals.amount_ex_tax || 0), 0))}）。
                作品ごとに1回ずつ登録し、止まる理由がある作品で止めます（それまでに登録した作品は登録済みのまま残ります）。登録した報告は消せません。</p>
              <div className="on-form-actions">
                <button type="button" disabled={Boolean(busy)} onClick={commitAll}>{busy === 'commit' ? '登録しています…' : 'すべて順番に登録する'}</button>
                <button type="button" className="secondary" disabled={Boolean(busy)} onClick={() => setConfirming(null)}>戻って直す</button>
              </div>
            </div>
          )}
          <ActionBar>
            <button type="button" className="secondary" disabled={Boolean(busy)} onClick={() => jump(4)}>戻る（割り当て）</button>
            {!activePartition.committed && <button type="button" className="secondary" disabled={Boolean(busy) || readOnly} onClick={() => { setNotice(null); setBusy('review'); reviewPartition(activePartition).finally(() => setBusy(null)); }}>もう一度確かめる</button>}
            {committedResultIds.length > 0 && <button type="button" className="secondary" disabled={Boolean(busy)} onClick={() => openResults(committedResultIds, auditWarnings.current)}>登録した作品の結果を見る</button>}
            {partitions.length > 1 && progress.remaining > 1 && !confirming && <button type="button" className="secondary" disabled={Boolean(busy) || readOnly || allBlocked} onClick={() => setConfirming('all')}>まだの作品をすべて順番に登録する</button>}
            {!activePartition.committed && !confirming && <button type="button" disabled={Boolean(busy) || blockers.length > 0} onClick={() => setConfirming('one')}>{partitions.length > 1 ? 'この作品を登録する' : '登録する'}</button>}
          </ActionBar>
        </section>
      )}

      {step === LAST_STEP && result && (
        <section className="card iw-step" aria-labelledby="iw-step6">
          <h3 id="iw-step6">6. 登録結果</h3>
          <Notice tone="ok" title={results.length > 1 ? `${results.length}作品の報告を登録しました` : '登録しました'} message={`データベースから読み直した内容です（${dateTimeJst(result.readAt)} 時点）。`} />
          {results.length > 1 && (
            <div className="iw-results">
              <table className="iw-mini">
                <thead><tr><th scope="col">作品</th><th scope="col">報告番号</th><th scope="col" className="num">件数</th><th scope="col" className="num">税抜</th><th scope="col" className="num">税込</th><th scope="col">状態</th><th scope="col"><span className="dg-vh">操作</span></th></tr></thead>
                <tbody>
                  {results.map((item, index) => (
                    <tr key={item.report.id} aria-current={index === resultIndex ? 'true' : undefined}>
                      <td>{item.report.workTitle}</td><td>{item.report.reportKey}</td><td className="num">{int(item.report.lineCount)}</td><td className="num">{int(item.report.totals.amountExTax)}</td><td className="num">{int(item.report.totals.amountIncTax)}</td>
                      <td>{labelOf('reportStatus', item.report.status)}</td>
                      <td>{index === resultIndex ? '表示中' : <button type="button" className="text" onClick={() => setResultIndex(index)}>詳しく見る</button>}</td>
                    </tr>
                  ))}
                  <tr className="iw-total-row"><th scope="row">合計</th><td /><td className="num">{int(results.reduce((sum, item) => sum + item.report.lineCount, 0))}</td><td className="num">{int(results.reduce((sum, item) => sum + item.report.totals.amountExTax, 0))}</td><td className="num">{int(results.reduce((sum, item) => sum + item.report.totals.amountIncTax, 0))}</td><td /><td /></tr>
                </tbody>
              </table>
              <h4>作品「{result.report.workTitle}」の報告</h4>
            </div>
          )}
          <ResultDetail result={result} navigate={navigate} sourceName={source?.fileName} />
          {partitions.length > 1 && !progress.complete && <Notice tone="warn" compact message={`まだ登録していない作品があります（${progress.label}）。`} actions={<button type="button" className="secondary" onClick={() => jump(5)}>残りの作品を確かめる</button>} />}
          <ActionBar>
            <button type="button" onClick={restart}>続けて取り込む</button>
          </ActionBar>
        </section>
      )}
    </div>
  );
}

export default SalesImportWizard;

// 画面の表示に使う定数（設計キャンバス・文書用）
export const SALES_IMPORT_STEPS = STEPS;
export const SALES_IMPORT_BASIS_FIELDS = BASIS_FIELDS;
export const SALES_IMPORT_ASSIGN_MODES = ASSIGN_MODES;
