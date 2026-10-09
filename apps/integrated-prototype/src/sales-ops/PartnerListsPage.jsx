// 営業基幹「取引先別の配信・販売リスト」。設計: docs/platform/team-development/eigyo-sales-sheet-design.md §3。
// タブ: 取引先別リスト（取引先 → リスト → 明細・版の履歴・新しい版・共通テンプレートの取込）／作品×取引先（重なり）／確認（終了間近・再契約の空白・
// 契約中の取引先が無い流通・期間外の売上）／追加の列（管理者が定義）。状態は基準日から計算する（保存しない）。条件は URL（pl*）に残す。
import React, {useCallback, useEffect, useId, useMemo, useRef, useState} from 'react';
import {useShell} from '../shell/context.mjs';
import {DataGrid} from '../ui/DataGrid.jsx';
import {Notice} from '../ui/Notice.jsx';
import {FormField} from '../ui/FormField.jsx';
import {Tabs} from '../ui/Tabs.jsx';
import {int, dateTimeJst} from '../ui/format.mjs';
import {decodeXlsx} from '../xlsx.mjs';
import {SalesSheetLink, useSalesSheetAccess} from '../sales-sheet/SalesSheetLink.jsx';
import {downloadReportXlsx, reportBaseName} from '../xlsx-report.mjs';
import {
  ENTRY_STATES, END_RULES, EXCLUSIVITY, ENTRY_STATUSES, SETTLEMENT_METHODS, FIELD_VALUE_TYPES, SALE_MATCH, PERIOD_BASES, SOON_DAYS,
  tableFromPartnerListSheets, failedPartnerListRows, todayJst,
} from './partner-list-model.mjs';
import {BroadcastTermsEditor} from '../broadcast/BroadcastTerms.jsx';
import '../reports/reports.css';
import './sales-ops.css';
import './release-windows.css';
import './partner-lists.css';

const P = 'pl'; // URL の条件の接頭辞
const STATE_TONE = {upcoming: 'info', active: 'ok', ending_soon: 'warn', ended: 'muted', auto_renew: 'ok', end_unknown: 'none', planned: 'info', withdrawn: 'muted'};
const ACTION_LABELS = {append: '追加', revise: '修正', unchanged: '変更なし', error: 'エラー'};
const dash = (value) => (value === null || value === undefined || value === '' ? <span className="dg-muted">—</span> : value);
const percent = (bps) => (bps === null || bps === undefined ? null : `${Number((bps / 100).toFixed(2))}%`);
const partsText = (row) => (row.parts?.length ? row.parts.map((part) => `${part}${row.before && Object.hasOwn(row.before, part) ? `: ${row.before[part] ?? '空欄'} → ${row.after[part] ?? '空欄'}` : ''}`).join(' ／ ') : null);

function useRequest(requestProp) {
  const shell = useShell();
  const ref = useRef(null);
  ref.current = requestProp || shell.request;
  return useCallback((path, options) => ref.current(path, options), []);
}

function useParams(shell) {
  const read = (key, fallback = '') => shell.getParam(`${P}${key}`, '') || fallback;
  const set = (key, value) => shell.setParam(`${P}${key}`, value === null || value === undefined || value === '' ? null : String(value), {replace: true});
  return [read, set];
}

export function EntryStateBadge({state, text}) {
  return <span className={`rw-state rw-state-${STATE_TONE[state] === 'warn' ? 'warn' : STATE_TONE[state] || 'none'} pl-state`}>{text || ENTRY_STATES[state] || state}</span>;
}

function periodText(entry) {
  const end = entry.end_rule === 'date' ? entry.contract_end : END_RULES[entry.end_rule];
  return `${entry.contract_start || '開始未定'}〜${end || ''}`;
}

// ---- 明細の入力（新しい明細・新しい版） ------------------------------------------------------------
function draftOf(entry, fields) {
  const values = {
    distribution_code: entry?.distribution_code || '', territory: entry?.territory || '日本', product_sku: entry?.product_sku || '',
    contract_start: entry?.contract_start || '', contract_end: entry?.contract_end || '', end_rule: entry?.end_rule || '', announce_on: entry?.announce_on || '',
    exclusivity: entry?.exclusivity || 'unknown', status: entry?.status || 'planned', settlement_method: entry?.settlement_method || 'unverified',
    amount_ex_tax: entry?.amount_ex_tax ?? '', rate_percent: entry?.rate_bps === null || entry?.rate_bps === undefined ? '' : String(Number((entry.rate_bps / 100).toFixed(2))),
    partner_work_code: entry?.partner_work_code || '', partner_category: entry?.partner_category || '', billing_partner_code: entry?.billing_partner_code || '',
    agreement_code: entry?.agreement_code || '', source_reference: entry?.source_reference || '', note: entry?.note || '',
  };
  const extra = {};
  for (const field of fields) {
    const value = entry?.fields?.[field.id];
    extra[field.id] = value ? String(value.n ?? value.t ?? '') : '';
  }
  return {values, fields: extra, workId: '', renewsEntryId: '', reason: ''};
}

function EntryForm({request, list, meta, fields, entry = null, works = [], listEntries = [], onSaved, onCancel}) {
  const shell = useShell();
  const [draft, setDraft] = useState(() => draftOf(entry, fields));
  const [notice, setNotice] = useState(null);
  const [busy, setBusy] = useState(false);
  const initial = useMemo(() => JSON.stringify(draftOf(entry, fields)), [entry, fields]);
  const dirty = JSON.stringify(draft) !== initial;
  const unsavedId = `partner-list-entry-${entry?.entry_id || 'new'}`;
  useEffect(() => {
    shell.registerUnsaved(unsavedId, dirty ? 1 : 0, entry ? `明細 ${entry.entry_id} の新しい版（入力中）` : '新しい明細（入力中）');
    return () => shell.registerUnsaved(unsavedId, 0);
  }, [dirty]); // eslint-disable-line react-hooks/exhaustive-deps
  const setValue = (key, value) => setDraft((previous) => ({...previous, values: {...previous.values, [key]: value}}));
  const setField = (id, value) => setDraft((previous) => ({...previous, fields: {...previous.fields, [id]: value}}));
  const renewable = listEntries.filter((item) => String(item.work_id) === String(draft.workId));
  async function save(event) {
    event.preventDefault();
    setBusy(true);
    setNotice(null);
    const values = {...draft.values, fields: draft.fields};
    try {
      if (entry) {
        const result = await request(`/partner-list-entries/${entry.entry_id}/versions`, {method: 'POST', body: JSON.stringify({baseVersion: entry.version_no, values, reason: draft.reason})});
        shell.registerUnsaved(unsavedId, 0);
        onSaved?.(`明細 ${entry.entry_id} の第${result.version}版を登録しました`);
      } else {
        const result = await request(`/partner-lists/${list.id}/entries`, {method: 'POST', body: JSON.stringify({workId: Number(draft.workId), renewsEntryId: draft.renewsEntryId || null, values, reason: draft.reason})});
        shell.registerUnsaved(unsavedId, 0);
        onSaved?.(`明細 ${result.entryId} を登録しました`);
      }
    } catch (error) {
      setNotice({error});
    } finally {
      setBusy(false);
    }
  }
  const codeOptions = (meta?.distributionCodes || []).map((item) => ({value: item.code, label: `${item.code} ${item.distribution_name}・${item.sales_type || item.transaction_method}`}));
  const options = (map) => Object.entries(map).map(([value, label]) => ({value, label}));
  return (
    <form className="rw-editor pl-form" onSubmit={save} aria-label={entry ? `明細 ${entry.entry_id} の新しい版` : `${list.name}に明細を追加`}>
      <h5>{entry ? `新しい版（第${entry.version_no + 1}版）` : '新しい明細'}</h5>
      <div className="rw-editor-grid">
        {!entry && <FormField type="select" label="作品" required value={draft.workId} onChange={(value) => setDraft((p) => ({...p, workId: value, renewsEntryId: ''}))}
          options={works.map((work) => ({value: String(work.id), label: `${work.code}｜${work.title}`}))} blankLabel="作品を選ぶ" />}
        {!entry && renewable.length > 0 && <FormField type="select" label="再契約元の明細（任意）" value={draft.renewsEntryId} onChange={(value) => setDraft((p) => ({...p, renewsEntryId: value}))}
          options={renewable.map((item) => ({value: String(item.entry_id), label: `#${item.entry_id} ${item.distribution_code} ${periodText(item)}`}))} blankLabel="再契約ではない" />}
        <FormField type="select" label="流通ID" required value={draft.values.distribution_code} onChange={(value) => setValue('distribution_code', value)} options={codeOptions} blankLabel="流通IDを選ぶ" />
        <FormField label="地域" value={draft.values.territory} onChange={(value) => setValue('territory', value)} hint="空欄は日本" />
        <FormField type="date" label="契約開始日" value={draft.values.contract_start} onChange={(value) => setValue('contract_start', value)} />
        <FormField type="date" label="契約終了日" value={draft.values.contract_end} onChange={(value) => setValue('contract_end', value)} />
        <FormField type="select" label="終了の扱い" value={draft.values.end_rule} onChange={(value) => setValue('end_rule', value)} options={options(END_RULES)} blankLabel="終了日から決める" />
        <FormField type="date" label="告知解禁日" value={draft.values.announce_on} onChange={(value) => setValue('announce_on', value)} />
        <FormField type="select" label="独占" includeBlank={false} value={draft.values.exclusivity} onChange={(value) => setValue('exclusivity', value)} options={options(EXCLUSIVITY)} />
        <FormField type="select" label="状態" includeBlank={false} value={draft.values.status} onChange={(value) => setValue('status', value)} options={options(ENTRY_STATUSES)} />
        <FormField type="select" label="取引方法" includeBlank={false} value={draft.values.settlement_method} onChange={(value) => setValue('settlement_method', value)} options={options(SETTLEMENT_METHODS)} />
        <FormField type="yen" label="契約金額（税抜）" allowNegative={false} value={String(draft.values.amount_ex_tax ?? '')} onChange={(value) => setValue('amount_ex_tax', value)} />
        <FormField label="料率（%）" value={draft.values.rate_percent} onChange={(value) => setValue('rate_percent', value)} placeholder="例: 50" />
        <FormField label="商品SKU" value={draft.values.product_sku} onChange={(value) => setValue('product_sku', value)} hint="任意。作品に配賦した商品" />
        <FormField label="取引先側の作品コード" value={draft.values.partner_work_code} onChange={(value) => setValue('partner_work_code', value)} />
        <FormField label="取引先側の区分" value={draft.values.partner_category} onChange={(value) => setValue('partner_category', value)} />
        <FormField label="請求先の取引先コード" value={draft.values.billing_partner_code} onChange={(value) => setValue('billing_partner_code', value)} hint="売上の相手が違うとき"
          suggestions={(meta?.partners || []).map((p) => p.code)} />
        <FormField label="販売契約コード" value={draft.values.agreement_code} onChange={(value) => setValue('agreement_code', value)} />
        <FormField label="根拠" value={draft.values.source_reference} onChange={(value) => setValue('source_reference', value)} hint="契約書・許諾通知書など" />
        <FormField label="備考" value={draft.values.note} onChange={(value) => setValue('note', value)} />
        {fields.map((field) => (field.value_type === 'choice'
          ? <FormField key={field.id} type="select" label={field.label} value={draft.fields[field.id]} onChange={(value) => setField(field.id, value)} options={(field.options || []).map((o) => ({value: o, label: o}))} blankLabel="未入力" />
          : <FormField key={field.id} type={field.value_type === 'yen' ? 'yen' : field.value_type === 'integer' ? 'int' : field.value_type === 'date' ? 'date' : field.value_type === 'month' ? 'month' : 'text'}
            label={field.label} value={draft.fields[field.id]} onChange={(value) => setField(field.id, value)} hint={`追加の列（${FIELD_VALUE_TYPES[field.value_type]}）`} />))}
      </div>
      <FormField type="textarea" label="理由" required rows={2} value={draft.reason} onChange={(value) => setDraft((p) => ({...p, reason: value}))} hint="版の履歴と監査記録に残ります" />
      {notice && <Notice error={notice.error} onDismiss={() => setNotice(null)} />}
      <div className="rw-editor-buttons">
        <button type="submit" disabled={busy || !dirty || !draft.reason.trim()}>{entry ? `この内容で第${entry.version_no + 1}版を登録する` : 'この明細を登録する'}</button>
        {onCancel && <button type="button" className="secondary" disabled={busy} onClick={onCancel}>やめる</button>}
      </div>
    </form>
  );
}

function EntryHistory({request, entry, list, meta, fields, readOnly, onSaved}) {
  const [state, setState] = useState({loading: true});
  const [revision, setRevision] = useState(0);
  const [message, setMessage] = useState('');
  useEffect(() => {
    let live = true;
    request(`/partner-list-entries/${entry.entry_id}/history`).then((body) => { if (live) setState({body}); }).catch((error) => { if (live) setState({error}); });
    return () => { live = false; };
  }, [request, entry.entry_id, revision]);
  const body = state.body;
  const columns = useMemo(() => [
    {key: 'version_no', label: '版', type: 'int', total: 'none', sticky: true},
    {key: 'distribution_code', label: '流通ID', type: 'code'},
    {key: 'period', label: '契約期間', type: 'text', value: (v) => periodText(v)},
    {key: 'status', label: '状態', type: 'text', value: (v) => ENTRY_STATUSES[v.status]},
    {key: 'exclusivity', label: '独占', type: 'text', value: (v) => EXCLUSIVITY[v.exclusivity]},
    {key: 'amount_ex_tax', label: '契約金額（税抜）', type: 'yen', total: 'none', render: (v) => dash(v.amount_ex_tax === null || v.amount_ex_tax === undefined ? null : int(v.amount_ex_tax))},
    {key: 'rate', label: '料率', type: 'text', value: (v) => percent(v.rate_bps), render: (v) => dash(percent(v.rate_bps))},
    ...fields.map((field) => ({key: `f:${field.id}`, label: field.label, type: 'text', value: (v) => { const x = v.fields?.[field.id]; return x ? String(x.n ?? x.t) : null; },
      render: (v) => { const x = v.fields?.[field.id]; return dash(x ? String(x.n ?? x.t) : null); }})),
    {key: 'note', label: '備考', type: 'text', render: (v) => dash(v.note)},
    {key: 'reason', label: '理由', type: 'text', wrap: true},
    {key: 'source', label: '経路', type: 'text', value: (v) => (v.import_batch_id ? `Excel取込（${v.batch_file_name || 'ファイル'}）` : '画面で入力')},
    {key: 'created_by_name', label: '登録者', type: 'text'},
    {key: 'created_at', label: '登録日時', type: 'text', value: (v) => dateTimeJst(v.created_at)},
  ], [fields]);
  return (
    <section className="rw-history pl-history" aria-label={`明細 ${entry.entry_id}（${entry.work_title}・${entry.distribution_code}）`}>
      <header className="rw-history-head">
        <h4>明細 {entry.entry_id}<small>{entry.work_code}｜{entry.work_title}｜{entry.distribution_code} {entry.distribution_name}｜{periodText(entry)}</small></h4>
        <EntryStateBadge state={entry.state} text={entry.state_text} />
      </header>
      {entry.overlaps?.length > 0 && (
        <Notice tone="warn" title="ほかの明細と期間が重なっています（登録は止めていません）"
          details={entry.overlaps.map((o) => ({message: `${o.severity === 'exclusive' ? '独占どうし' : '注意'}: ${o.partner_name}「${o.list_name}」の明細 ${o.entry_id}（${o.from}〜${o.to || '期限なし'}）`}))} />
      )}
      {body?.entry?.renews_entry_id && <p className="rp-muted">明細 {body.entry.renews_entry_id} の再契約です。</p>}
      {body?.entry?.renewed_by?.length > 0 && <p className="rp-muted">再契約: 明細 {body.entry.renewed_by.join('・')}</p>}
      {message && <Notice tone="ok" message={message} onDismiss={() => setMessage('')} />}
      {state.error && <Notice error={state.error} onRetry={() => setRevision((n) => n + 1)} />}
      {body && <DataGrid columns={columns} rows={body.versions} rowKey="version_no" ariaLabel={`明細 ${entry.entry_id} の版の履歴`} showTotals={false} maxHeight="40vh" />}
      {entry.distribution_name === '放送' && <BroadcastTermsEditor request={request} entryId={entry.entry_id} readOnly={readOnly} />}
      {body && !readOnly && body.canEdit && (
        <EntryForm key={body.versions[0]?.version_no} request={request} list={list} meta={meta} fields={fields} entry={{...entry, ...body.versions[0], entry_id: entry.entry_id}}
          onSaved={(text) => { setMessage(text); setRevision((n) => n + 1); onSaved?.(); }} />
      )}
      {body && !body.canEdit && <p className="rp-muted">この作品は直せません。案件の編集権限がある人が直します。</p>}
    </section>
  );
}

// ---- Excel の取込 ----------------------------------------------------------------------------------
function ImportPanel({request, list, onCommitted}) {
  const shell = useShell();
  const inputId = useId();
  const [inputKey, setInputKey] = useState(0);
  const [mode, setMode] = useState('partial');
  const [upload, setUpload] = useState(null);
  const [preview, setPreview] = useState(null);
  const [notice, setNotice] = useState(null);
  const [reason, setReason] = useState('');
  const [withdrawMissing, setWithdrawMissing] = useState(false);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    shell.registerUnsaved('partner-list-import', preview?.token ? 1 : 0, '取引先リストの Excel 取込（確認中）');
    return () => shell.registerUnsaved('partner-list-import', 0);
  }, [preview]); // eslint-disable-line react-hooks/exhaustive-deps
  async function runPreview(next, nextMode = mode) {
    setBusy(true);
    setPreview(null);
    try {
      const result = await request(`/partner-lists/${list.id}/import/preview`, {method: 'POST', body: JSON.stringify({table: next.table, fileName: next.fileName, mode: nextMode})});
      setPreview(result);
      const c = result.counts;
      setNotice(result.token
        ? {tone: result.warnings?.length ? 'warn' : 'info', title: `${next.fileName} の内容（まだ登録していません）`,
          message: `追加 ${c.append}件・修正 ${c.revise}件・変更なし ${c.unchanged}件${nextMode === 'full' ? `・取り下げ候補 ${c.withdraw}件` : ''}。理由を書いて「この内容で登録する」を押してください`,
          details: (result.warnings || []).map((message) => ({message}))}
        : {tone: 'info', title: `${next.fileName} の内容`, message: `変更はありません（${c.rows}行すべて今の版と同じです）`, details: (result.warnings || []).map((message) => ({message}))});
    } catch (error) {
      const body = error?.body && typeof error.body === 'object' ? error.body : null;
      setNotice({error, failed: body?.failedRows?.length ? body : null, rows: body?.rows || null});
    } finally {
      setBusy(false);
    }
  }
  async function choose(event) {
    const file = event.target.files?.[0];
    if (!file) return;
    try {
      if (!/\.xlsx$/i.test(file.name)) throw new Error('テンプレートか出力した Excel（.xlsx）を選んでください');
      const table = tableFromPartnerListSheets(decodeXlsx(new Uint8Array(await file.arrayBuffer()), {formulas: 'sheet', percent: 'text'}));
      const next = {fileName: file.name, table};
      setUpload(next);
      await runPreview(next);
    } catch (error) {
      setUpload(null);
      setNotice({error});
    }
  }
  async function commit() {
    setBusy(true);
    try {
      const result = await request(`/partner-lists/${list.id}/import/commit`, {method: 'POST', body: JSON.stringify({token: preview.token, reason, confirmed: true, withdrawMissing})});
      shell.registerUnsaved('partner-list-import', 0);
      setPreview(null); setUpload(null); setReason(''); setWithdrawMissing(false); setInputKey((n) => n + 1);
      setNotice({tone: 'ok', message: `登録しました（追加 ${result.appended}件・修正 ${result.revised}件・取り下げ ${result.withdrawn}件）`});
      onCommitted?.();
    } catch (error) {
      setNotice({error, expired: error?.status === 410});
    } finally {
      setBusy(false);
    }
  }
  function downloadFailed() {
    const failed = notice?.failed;
    if (!failed) return;
    const {columns, rows} = failedPartnerListRows({headers: failed.headers || [], rows: failed.failedRows});
    downloadReportXlsx(reportBaseName(`${list.name}_登録できない行`), {sheets: [{name: '失敗行', titleBand: false, freezeCols: 1, columns, rows}]});
  }
  const rows = (preview?.rows || notice?.rows || []).filter((row) => row.action !== 'unchanged');
  const columns = useMemo(() => [
    {key: 'rowNo', label: '行', type: 'int', total: 'none', sticky: true},
    {key: 'entryId', label: '明細ID', type: 'int', total: 'none', render: (row) => dash(row.entryId ?? (row.action === 'append' ? '新規' : null))},
    {key: 'workCode', label: '作品コード', type: 'code', render: (row) => dash(row.workCode)},
    {key: 'workTitle', label: '作品', type: 'text', render: (row) => dash(row.workTitle)},
    {key: 'action', label: '扱い', type: 'text', value: (row) => ACTION_LABELS[row.action] || row.action},
    {key: 'parts', label: '変わる項目（前 → 後）', type: 'text', wrap: true, value: partsText, render: (row) => dash(partsText(row))},
    {key: 'warnings', label: '警告', type: 'text', wrap: true, value: (row) => (row.warnings || []).join(' ／ ') || null, render: (row) => dash((row.warnings || []).join(' ／ '))},
    {key: 'errors', label: 'エラー', type: 'text', wrap: true, value: (row) => (row.errors || []).join(' ／ ') || null, render: (row) => ((row.errors || []).length ? <span className="pl-excl-text">{row.errors.join(' ／ ')}</span> : dash(null))},
  ], []);
  const withdrawColumns = useMemo(() => [
    {key: 'entryId', label: '明細ID', type: 'int', total: 'none'}, {key: 'workCode', label: '作品コード', type: 'code'}, {key: 'workTitle', label: '作品', type: 'text'},
    {key: 'distributionCode', label: '流通ID', type: 'code'}, {key: 'period', label: '契約期間', type: 'text', value: (row) => `${row.contractStart || ''}〜${row.contractEnd || ''}`},
    {key: 'canEdit', label: '取り下げ', type: 'text', value: (row) => (row.canEdit ? '候補' : '権限なし（取り下げない）')},
  ], []);
  if (shell.readOnly) return null;
  return (
    <section className="card rw-section" aria-label="共通テンプレートの取込">
      <header>
        <h3>Excel で取り込む（全取引先で同じ形式）</h3>
        <p className="rp-muted">「テンプレート」か「現在の明細を出力」で出した Excel に書いて読み込みます。明細IDのある行はその明細の修正、空欄は新しい明細です。1行でもエラーがあれば何も登録しません。</p>
      </header>
      <div className="rw-upload">
        <fieldset className="pl-mode">
          <legend>読み込みの範囲</legend>
          <label><input type="radio" name={`${inputId}-mode`} checked={mode === 'partial'} onChange={() => { setMode('partial'); if (upload) runPreview(upload, 'partial'); }} />ファイルの行だけ</label>
          <label><input type="radio" name={`${inputId}-mode`} checked={mode === 'full'} onChange={() => { setMode('full'); if (upload) runPreview(upload, 'full'); }} />リスト全件（ファイルに無い明細は取り下げ候補）</label>
        </fieldset>
        <div className="pl-upload-file">
          <label htmlFor={inputId}>Excel（.xlsx）を読み込む</label>
          <input key={inputKey} id={inputId} type="file" disabled={busy} accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" onChange={choose} />
          {busy && <span className="rp-muted" role="status">確認しています…</span>}
        </div>
      </div>
      {notice && (
        <Notice tone={notice.tone} title={notice.title} message={notice.message} details={notice.details} error={notice.error}
          onRetry={notice.expired && upload ? () => runPreview(upload) : undefined} retryLabel="もう一度確認する"
          actions={notice.failed ? <button type="button" className="secondary" onClick={downloadFailed}>エラーの行をExcelで受け取る</button> : undefined}
          onDismiss={() => setNotice(null)} />
      )}
      {rows.length > 0 && <DataGrid columns={columns} rows={rows} rowKey="rowNo" ariaLabel="取込内容の確認" maxHeight="45vh" showTotals={false} />}
      {preview?.withdraw?.length > 0 && <DataGrid columns={withdrawColumns} rows={preview.withdraw} rowKey="entryId" ariaLabel="取り下げ候補" maxHeight="30vh" showTotals={false} />}
      {preview?.token && (
        <div className="rw-editor">
          {preview.withdraw?.some((item) => item.canEdit) && (
            <label className="dg-check"><input type="checkbox" checked={withdrawMissing} onChange={(event) => setWithdrawMissing(event.target.checked)} />ファイルに無い明細（取り下げ候補）を取り下げる</label>
          )}
          <FormField type="textarea" label="取込の理由" required rows={2} value={reason} onChange={setReason} hint="登録する各版の理由と監査記録に残ります" />
          <div className="rw-editor-buttons">
            <button type="button" disabled={busy || !reason.trim()} onClick={commit}>この内容で登録する</button>
            <button type="button" className="secondary" disabled={busy} onClick={() => { setPreview(null); setUpload(null); setReason(''); setNotice(null); setInputKey((n) => n + 1); }}>取り消す</button>
          </div>
        </div>
      )}
    </section>
  );
}

// ---- 取引先別リスト ------------------------------------------------------------------------------------
function NewListForm({request, meta, partnerId, onCreated, onCancel}) {
  const [draft, setDraft] = useState({listKind: meta.kinds[0]?.code || 'distribution', name: '', serviceName: '', contractReference: '', reason: ''});
  const [notice, setNotice] = useState(null);
  const [busy, setBusy] = useState(false);
  const update = (key, value) => setDraft((p) => ({...p, [key]: value}));
  async function submit(event) {
    event.preventDefault();
    setBusy(true);
    try {
      const result = await request('/partner-lists', {method: 'POST', body: JSON.stringify({partnerId: Number(partnerId), ...draft})});
      onCreated?.(result.id, `リスト「${draft.name}」を作りました`);
    } catch (error) {
      setNotice({error});
    } finally {
      setBusy(false);
    }
  }
  return (
    <form className="rw-type-form" onSubmit={submit} aria-label="リストを作る">
      <div className="rw-field-row">
        <FormField type="select" label="種類" includeBlank={false} value={draft.listKind} onChange={(value) => update('listKind', value)} options={meta.kinds.map((k) => ({value: k.code, label: k.label}))} />
        <FormField label="リストの名前" required value={draft.name} onChange={(value) => update('name', value)} placeholder="例: 見放題の配信リスト" />
        <FormField label="サービス名" value={draft.serviceName} onChange={(value) => update('serviceName', value)} />
        <FormField label="基本契約の参照" value={draft.contractReference} onChange={(value) => update('contractReference', value)} />
      </div>
      <FormField type="textarea" label="理由" required rows={2} value={draft.reason} onChange={(value) => update('reason', value)} />
      {notice && <Notice error={notice.error} onDismiss={() => setNotice(null)} />}
      <div className="rw-editor-buttons">
        <button type="submit" disabled={busy || !draft.name.trim() || !draft.reason.trim()}>リストを作る</button>
        <button type="button" className="secondary" onClick={onCancel}>やめる</button>
      </div>
    </form>
  );
}

function EntriesPanel({request, list, meta, asOf, soonDays, onChanged}) {
  const shell = useShell();
  const [state, setState] = useState({loading: true});
  const [revision, setRevision] = useState(0);
  const [adding, setAdding] = useState(false);
  const [message, setMessage] = useState('');
  useEffect(() => {
    let live = true;
    setState((previous) => ({...previous, loading: true}));
    request(`/partner-lists/${list.id}/entries?asOf=${asOf}&soonDays=${soonDays}`).then((body) => { if (live) setState({body}); }).catch((error) => { if (live) setState({error}); });
    return () => { live = false; };
  }, [request, list.id, asOf, soonDays, revision]);
  const body = state.body;
  const fields = body?.fields || [];
  const reload = () => { setRevision((n) => n + 1); onChanged?.(); };
  // 財務の権限がある人には、明細の作品×この取引先で絞った売上集計シートを開くリンクを出す
  const access = useSalesSheetAccess(request);
  const columns = useMemo(() => [
    {key: 'entry_id', label: '明細ID', type: 'int', total: 'none', sticky: true},
    {key: 'work_code', label: '作品コード', type: 'code', sticky: true},
    {key: 'work_title', label: '作品名', type: 'text'},
    {key: 'state', label: '状態（基準日）', type: 'text', value: (row) => row.state_text, render: (row) => <EntryStateBadge state={row.state} text={row.state_text} />},
    {key: 'overlaps', label: '重なり', type: 'text', value: (row) => (row.overlaps?.length ? `${row.overlaps.length}件` : null),
      render: (row) => (row.overlaps?.length ? <span className={row.overlaps.some((o) => o.severity === 'exclusive') ? 'pl-excl-text' : 'rw-warn-text'}>{row.overlaps.some((o) => o.severity === 'exclusive') ? '独占どうし' : '注意'} {row.overlaps.length}件</span> : dash(null))},
    {key: 'distribution_code', label: '流通ID', type: 'code'},
    {key: 'distribution_name', label: '流通名・販売種別', type: 'text', value: (row) => [row.distribution_name, row.sales_type].filter(Boolean).join('・')},
    {key: 'territory', label: '地域', type: 'text'},
    {key: 'contract_start', label: '契約開始日', type: 'text', render: (row) => dash(row.contract_start)},
    {key: 'contract_end', label: '契約終了日', type: 'text', render: (row) => dash(row.contract_end)},
    {key: 'end_rule', label: '終了の扱い', type: 'text', value: (row) => END_RULES[row.end_rule]},
    {key: 'exclusivity', label: '独占', type: 'text', value: (row) => EXCLUSIVITY[row.exclusivity]},
    {key: 'status', label: '状態（登録）', type: 'text', value: (row) => ENTRY_STATUSES[row.status]},
    {key: 'settlement_method', label: '取引方法', type: 'text', value: (row) => SETTLEMENT_METHODS[row.settlement_method]},
    {key: 'amount_ex_tax', label: '契約金額（税抜）', type: 'yen', total: 'none', render: (row) => dash(row.amount_ex_tax === null || row.amount_ex_tax === undefined ? null : int(row.amount_ex_tax))},
    {key: 'rate', label: '料率', type: 'text', value: (row) => percent(row.rate_bps), render: (row) => dash(percent(row.rate_bps))},
    {key: 'announce_on', label: '告知解禁日', type: 'text', hidden: true, render: (row) => dash(row.announce_on)},
    {key: 'partner_work_code', label: '取引先側の作品コード', type: 'text', hidden: true, render: (row) => dash(row.partner_work_code)},
    {key: 'partner_category', label: '取引先側の区分', type: 'text', render: (row) => dash(row.partner_category)},
    {key: 'billing_partner_code', label: '請求先', type: 'code', hidden: true},
    {key: 'renews_entry_id', label: '再契約元', type: 'int', total: 'none', hidden: true},
    {key: 'source_reference', label: '根拠', type: 'text', hidden: true},
    {key: 'note', label: '備考', type: 'text', hidden: true},
    ...fields.map((field) => ({key: `f:${field.id}`, label: field.label, type: field.value_type === 'yen' ? 'yen' : field.value_type === 'integer' ? 'int' : 'text', total: 'none',
      value: (row) => { const v = row.fields?.[field.id]; return v ? v.n ?? v.t : null; },
      render: (row) => { const v = row.fields?.[field.id]; return dash(v ? (v.n !== null && v.n !== undefined ? int(v.n) : v.t) : null); }})),
    {key: 'version_no', label: '版', type: 'int', total: 'none'},
    ...(access?.canOpen ? [{key: 'sales_sheet', label: '売上', type: 'text', export: false, sortable: false, value: () => null,
      render: (row) => <SalesSheetLink access={access} workId={row.work_id} partnerId={list.partner_id} label="売上集計シート" />}] : []),
  ], [fields, access, list.partner_id]);
  const templateHref = `/api/partner-lists/${list.id}/template.xlsx`;
  const currentHref = `/api/partner-lists/${list.id}/template.xlsx?kind=current&asOf=${asOf}&soonDays=${soonDays}`;
  return (
    <div className="stack">
      <section className="card rp-report" aria-label={`${list.partner_name} ${list.name}`}>
        <header className="so-head">
          <div>
            <h2>{list.name}<small className="pl-kind">{list.kind_label}</small></h2>
            <p className="rp-muted">{list.partner_code}｜{list.partner_name}{list.service_name ? `｜サービス: ${list.service_name}` : ''}{list.contract_reference ? `｜基本契約: ${list.contract_reference}` : ''}</p>
          </div>
          <div className="so-actions">
            <a className="bc-link-button rw-link-button" href={templateHref} download>テンプレート（空）</a>
            <a className="bc-link-button rw-link-button" href={currentHref} download>現在の明細を Excel で出力</a>
            {!shell.readOnly && body?.canEdit && <button type="button" className="secondary" onClick={() => setAdding((v) => !v)}>{adding ? '追加をやめる' : '＋明細を追加'}</button>}
          </div>
        </header>
        {body && (
          <p className="rp-meta" aria-live="polite">
            <span>明細 {int(body.counts.entries)}件</span>
            {Object.entries(body.counts.byState).map(([key, n]) => <span key={key}>{ENTRY_STATES[key] || key} {int(n)}</span>)}
            {body.counts.overlaps > 0 && <span className="rp-warn">重なりのある明細 {int(body.counts.overlaps)}件</span>}
          </p>
        )}
        {message && <Notice tone="ok" message={message} onDismiss={() => setMessage('')} />}
        {state.error && <Notice error={state.error} onRetry={() => setRevision((n) => n + 1)} />}
        {adding && body && (
          <EntryForm request={request} list={list} meta={meta} fields={fields} works={body.works} listEntries={body.entries}
            onSaved={(text) => { setMessage(text); setAdding(false); reload(); }} onCancel={() => setAdding(false)} />
        )}
        {state.loading && !body && <p className="rp-muted" aria-busy="true">読み込み中…</p>}
        {body && (
          <DataGrid columns={columns} rows={body.entries} rowKey="entry_id" persistKey="partner-list-entries" ariaLabel={`${list.name}の明細`} showTotals={false} maxHeight="60vh"
            emptyText="まだ明細がありません。「＋明細を追加」か Excel の取込で登録します。"
            renderDetail={(row) => <EntryHistory request={request} entry={row} list={list} meta={meta} fields={fields} readOnly={shell.readOnly} onSaved={reload} />} />
        )}
      </section>
      <ImportPanel request={request} list={list} onCommitted={reload} />
    </div>
  );
}

function ListsTab({request, meta, asOf, soonDays, onChanged}) {
  const shell = useShell();
  const [read, set] = useParams(shell);
  const [creating, setCreating] = useState(false);
  const [message, setMessage] = useState('');
  const partnersWithLists = meta.partners.filter((p) => p.listCount > 0);
  const partnerId = read('partner') || String(partnersWithLists[0]?.id || meta.partners[0]?.id || '');
  const lists = meta.lists.filter((list) => String(list.partner_id) === String(partnerId));
  const listId = read('list');
  const list = lists.find((item) => String(item.id) === listId) || lists[0] || null;
  return (
    <div className="stack">
      <section className="card rw-section" aria-label="取引先とリスト">
        <div className="rw-filters">
          <FormField type="select" label="取引先" className="pl-partner" includeBlank={false} value={partnerId} onChange={(value) => { set('partner', value); set('list', null); setCreating(false); }}
            options={meta.partners.map((p) => ({value: String(p.id), label: `${p.code}｜${p.name}${p.listCount ? `（リスト ${p.listCount}）` : ''}`}))} />
        </div>
        <div className="rw-type-picker" role="group" aria-label="リスト">
          {lists.map((item) => (
            <button key={item.id} type="button" className={`secondary rw-type-button${list?.id === item.id ? ' is-selected' : ''}`} aria-pressed={list?.id === item.id} onClick={() => set('list', item.id)}>
              {item.name}<small className="pl-kind">{item.kind_label}・{int(item.entryCount)}件</small>
            </button>
          ))}
          {!lists.length && <p className="rp-muted">この取引先にはまだリストがありません。</p>}
          {!shell.readOnly && !creating && <button type="button" className="secondary" onClick={() => setCreating(true)}>＋リストを作る</button>}
        </div>
        {message && <Notice tone="ok" message={message} onDismiss={() => setMessage('')} />}
        {creating && <NewListForm request={request} meta={meta} partnerId={partnerId} onCancel={() => setCreating(false)}
          onCreated={(id, text) => { setCreating(false); setMessage(text); set('list', id); onChanged?.(); }} />}
      </section>
      {list && <EntriesPanel key={list.id} request={request} list={list} meta={meta} asOf={asOf} soonDays={soonDays} onChanged={onChanged} />}
    </div>
  );
}

// ---- 作品×取引先の表 ------------------------------------------------------------------------------------
function MatrixTab({request, meta, asOf, soonDays}) {
  const shell = useShell();
  const [read, set] = useParams(shell);
  const kind = read('mkind'), q = read('mq'), onlyOverlaps = read('mover') === '1';
  const [qText, setQText] = useState(q);
  const [state, setState] = useState({loading: true});
  useEffect(() => {
    let live = true;
    const search = new URLSearchParams({asOf, soonDays: String(soonDays)});
    if (kind) search.set('kind', kind);
    if (q) search.set('q', q);
    if (onlyOverlaps) search.set('overlaps', '1');
    setState((previous) => ({...previous, loading: true}));
    request(`/partner-lists/matrix?${search}`).then((body) => { if (live) setState({body}); }).catch((error) => { if (live) setState({error}); });
    return () => { live = false; };
  }, [request, asOf, soonDays, kind, q, onlyOverlaps]);
  const body = state.body;
  const columns = useMemo(() => {
    if (!body) return [];
    return [
      {key: 'work_code', label: '作品コード', type: 'code', sticky: true},
      {key: 'work_title', label: '作品名', type: 'text', sticky: true},
      {key: 'overlap', label: '重なり', type: 'text', value: (row) => (row.overlap === 'exclusive' ? '独占どうし' : row.overlap ? '注意' : null),
        render: (row) => (row.overlap === 'exclusive' ? <span className="pl-excl-text">独占どうし</span> : row.overlap ? <span className="rw-warn-text">注意</span> : dash(null))},
      ...body.columns.map((column) => ({key: column.key, group: column.partner_name, label: column.label, type: 'text',
        value: (row) => (row.cells[column.key] || []).map((item) => `${item.contract_start || ''}〜${item.contract_end || END_RULES[item.end_rule]}（${item.state_text}）`).join('\n') || null,
        render: (row) => {
          const items = row.cells[column.key] || [];
          if (!items.length) return dash(null);
          return (
            <div className="pl-cell-list">
              {items.map((item) => (
                <span key={item.entry_id} className={`pl-cell pl-cell-${item.overlap || 'none'}${item.status === 'planned' ? ' pl-cell-planned' : ''}`}
                  title={`${item.list_name}・明細 ${item.entry_id}・${EXCLUSIVITY[item.exclusivity]}${item.overlap ? `・${item.overlap === 'exclusive' ? '独占どうしの重なり' : '重なり（注意）'}` : ''}`}>
                  {item.contract_start || '開始未定'}〜{item.contract_end || END_RULES[item.end_rule]}
                  <small>{item.state_text}{item.exclusivity === 'exclusive' ? '・独占' : ''}</small>
                </span>
              ))}
            </div>
          );
        }})),
    ];
  }, [body]);
  const pairColumns = useMemo(() => [
    {key: 'severity', label: '重なり', type: 'text', value: (row) => (row.severity === 'exclusive' ? '独占どうし' : '注意'),
      render: (row) => (row.severity === 'exclusive' ? <span className="pl-excl-text">独占どうし</span> : <span className="rw-warn-text">注意</span>)},
    {key: 'work_code', label: '作品コード', type: 'code'}, {key: 'work_title', label: '作品名', type: 'text'},
    {key: 'left', label: '明細A', type: 'text', value: (row) => `${row.left.partner_name}「${row.left.list_name}」#${row.left.entry_id} ${row.left.distribution_code} ${row.left.contract_start}〜${row.left.contract_end || '期限なし'}`},
    {key: 'right', label: '明細B', type: 'text', value: (row) => `${row.right.partner_name}「${row.right.list_name}」#${row.right.entry_id} ${row.right.distribution_code} ${row.right.contract_start}〜${row.right.contract_end || '期限なし'}`},
    {key: 'range', label: '重なる期間', type: 'text', value: (row) => `${row.from}〜${row.to || '期限なし'}`},
  ], []);
  return (
    <section className="card rp-report" aria-label="作品×取引先">
      <p className="rp-muted">行が作品、列が取引先×流通ID。セルは契約期間と基準日の状態です。独占どうしの重なりは赤、ほかの重なり（非独占・独占未確認・予定を含む）は注意で、どちらも登録は止めません。取り下げた明細は出しません。</p>
      <div className="rw-filters" role="search" aria-label="作品×取引先の絞り込み">
        <FormField type="select" label="リストの種類" value={kind} blankLabel="すべて" onChange={(value) => set('mkind', value)} options={meta.kinds.map((k) => ({value: k.code, label: k.label}))} />
        <form className="rw-q" onSubmit={(event) => { event.preventDefault(); set('mq', qText.trim()); }}>
          <FormField type="search" label="作品コード・作品名" value={qText} onChange={setQText} />
          <button type="submit" className="secondary">探す</button>
        </form>
        <label className="dg-check rw-warn-only"><input type="checkbox" checked={onlyOverlaps} onChange={(event) => set('mover', event.target.checked ? '1' : null)} />重なりのある作品だけ</label>
      </div>
      {body && (
        <p className="rp-meta" aria-live="polite">
          <span>作品 {int(body.counts.works)}件</span><span>明細 {int(body.counts.entries)}件</span>
          <span className={body.counts.exclusive ? 'pl-excl-text' : ''}>独占どうしの重なり {int(body.counts.exclusive)}件</span>
          <span className={body.counts.caution ? 'rp-warn' : ''}>注意の重なり {int(body.counts.caution)}件</span>
          <span>リストに載っていない作品 {int(body.worksWithout)}件</span>
        </p>
      )}
      <p className="pl-legend" aria-label="色の意味"><span className="pl-cell pl-cell-exclusive">赤</span>独占どうしの重なり <span className="pl-cell pl-cell-caution">黄</span>そのほかの重なり <span className="pl-cell pl-cell-none pl-cell-planned">点線</span>予定</p>
      {state.error && <Notice error={state.error} />}
      {state.loading && !body && <p className="rp-muted" aria-busy="true">読み込み中…</p>}
      {body && <DataGrid key={body.columns.map((c) => c.key).join(',')} columns={columns} rows={body.rows} rowKey="work_id" ariaLabel="作品×取引先" showTotals={false} maxHeight="60vh"
        emptyText="条件に合う明細がありません。" />}
      {body && body.pairs.length > 0 && (
        <>
          <h3>重なりの一覧（{int(body.pairs.length)}件）</h3>
          <DataGrid columns={pairColumns} rows={body.pairs.map((p) => ({...p, key: `${p.a}-${p.b}`}))} rowKey="key" ariaLabel="重なりの一覧" showTotals={false} maxHeight="40vh" />
        </>
      )}
    </section>
  );
}

// ---- 確認 ----------------------------------------------------------------------------------------------
function ChecksTab({request, asOf}) {
  const shell = useShell();
  const [read, set] = useParams(shell);
  const basis = read('basis', 'month'), from = read('from'), to = read('to'), status = read('sstatus');
  const [state, setState] = useState({loading: true});
  useEffect(() => {
    let live = true;
    const search = new URLSearchParams({asOf, basis});
    if (from) search.set('from', from);
    if (to) search.set('to', to);
    if (status) search.set('status', status);
    setState((previous) => ({...previous, loading: true}));
    request(`/partner-lists/checks?${search}`).then((body) => { if (live) setState({body}); }).catch((error) => { if (live) setState({error}); });
    return () => { live = false; };
  }, [request, asOf, basis, from, to, status]);
  const body = state.body;
  const entryColumns = (extra) => [
    ...extra,
    {key: 'work_code', label: '作品コード', type: 'code'}, {key: 'work_title', label: '作品名', type: 'text'},
    {key: 'distribution_code', label: '流通ID', type: 'code'}, {key: 'period', label: '契約期間', type: 'text', value: (row) => periodText(row)},
    {key: 'partner_name', label: '取引先', type: 'text'}, {key: 'list_name', label: 'リスト', type: 'text'},
    {key: 'exclusivity', label: '独占', type: 'text', value: (row) => EXCLUSIVITY[row.exclusivity]},
  ];
  const soonColumns = useMemo(() => entryColumns([
    {key: 'bucket', label: '区切り', type: 'text', value: (row) => `${row.bucket}日以内`},
    {key: 'daysLeft', label: '残り日数', type: 'int', total: 'none'},
    {key: 'renewed', label: '再契約', type: 'text', value: (row) => (row.renewed ? 'あり' : 'なし')},
  ]), []); // eslint-disable-line react-hooks/exhaustive-deps
  const gapColumns = useMemo(() => [
    {key: 'work', label: '作品', type: 'text', value: (row) => `${row.nextEntry.work_code}｜${row.nextEntry.work_title}`},
    {key: 'list', label: '取引先・リスト', type: 'text', value: (row) => `${row.nextEntry.partner_name}「${row.nextEntry.list_name}」`},
    {key: 'prev', label: '前の契約', type: 'text', value: (row) => `#${row.prevEntry.entry_id} ${row.prevEntry.distribution_code} ${periodText(row.prevEntry)}`},
    {key: 'next', label: '次の契約', type: 'text', value: (row) => `#${row.nextEntry.entry_id} ${row.nextEntry.distribution_code} ${periodText(row.nextEntry)}`},
    {key: 'range', label: '空白', type: 'text', value: (row) => `${row.from}〜${row.to}`},
    {key: 'days', label: '日数', type: 'int', total: 'none'},
  ], []);
  const uncoveredColumns = useMemo(() => [
    {key: 'work_code', label: '作品コード', type: 'code'}, {key: 'work_title', label: '作品名', type: 'text'},
    {key: 'distribution', label: '流通', type: 'text', value: (row) => `${row.distribution_code} ${row.distribution_name}（${row.flow_text}）`},
    {key: 'territory', label: '地域', type: 'text'}, {key: 'period', label: '当社の販売条件', type: 'text', value: (row) => `${row.release_on}〜${row.sales_end_on}`},
    {key: 'note', label: '明細', type: 'text', value: (row) => [row.planned.length ? `予定 ${row.planned.map((id) => `#${id}`).join('・')}` : '', row.notCurrent.length ? `契約済（基準日は期間外） ${row.notCurrent.map((id) => `#${id}`).join('・')}` : ''].filter(Boolean).join(' ／ ') || '取引先の明細なし'},
  ], []);
  const saleColumns = useMemo(() => [
    {key: 'status', label: '照合の結果', type: 'text', value: (row) => row.status_text, render: (row) => <span className={row.status === 'flow_mismatch' ? 'rw-warn-text' : row.status === 'in_period' ? '' : 'pl-excl-text'}>{row.status_text}</span>},
    {key: 'work_code', label: '作品コード', type: 'code'}, {key: 'work_title', label: '作品名', type: 'text'}, {key: 'partner_name', label: '売上の取引先', type: 'text'},
    {key: 'accounting_month', label: '計上月', type: 'text'}, {key: 'sales_period', label: '販売期間', type: 'text', value: (row) => `${row.sales_period_from}〜${row.sales_period_to}`},
    {key: 'amount_ex_tax', label: '金額（税抜・配賦後）', type: 'yen'}, {key: 'flow', label: '流通', type: 'text', value: (row) => `${row.distribution_code || '分類なし'}（${row.flow_text}・${row.flow_basis}）`},
    {key: 'entries', label: '照合した明細', type: 'text', wrap: true, render: (row) => dash(row.entries)}, {key: 'description', label: '摘要', type: 'text', hidden: true}, {key: 'report_key', label: '報告', type: 'code', hidden: true},
  ], []);
  if (state.error) return <Notice error={state.error} />;
  if (!body) return <p className="rp-muted" aria-busy="true">読み込み中…</p>;
  const sales = body.sales;
  return (
    <div className="stack">
      <section className="card rp-report" aria-label="終了間近の契約">
        <h3>30・60・90日以内に終わる契約</h3>
        <p className="rp-meta"><span>30日以内 {int(body.soonCounts[30])}件</span><span>31〜60日 {int(body.soonCounts[60])}件</span><span>61〜90日 {int(body.soonCounts[90])}件</span></p>
        <DataGrid columns={soonColumns} rows={body.endingSoon} rowKey="entry_id" ariaLabel="終了間近の契約" showTotals={false} maxHeight="40vh" emptyText="90日以内に終わる契約はありません。" />
      </section>
      <section className="card rp-report" aria-label="再契約の空白">
        <h3>再契約の空白（{int(body.gaps.length)}件）</h3>
        <p className="rp-muted">同じ取引先のリストで、同じ作品・流通ID・地域の契約が途切れている期間です。</p>
        <DataGrid columns={gapColumns} rows={body.gaps.map((g) => ({...g, key: `${g.prev}-${g.next}`}))} rowKey="key" ariaLabel="再契約の空白" showTotals={false} maxHeight="40vh" emptyText="空白はありません。" />
      </section>
      <section className="card rp-report" aria-label="契約中の取引先が無い流通">
        <h3>当社は売れるのに、契約中の取引先が無い流通（{int(body.uncovered.length)}件）</h3>
        <p className="rp-muted">流通別の販売条件が「条件確認済み」で基準日が販売期間の中なのに、同じ流通（区分と配信の種類で照合）で契約中の明細が無いものです。</p>
        <DataGrid columns={uncoveredColumns} rows={body.uncovered.map((u) => ({...u, key: `${u.work_id}-${u.distribution_code}-${u.territory}`}))} rowKey="key" ariaLabel="契約中の取引先が無い流通" showTotals={false} maxHeight="40vh" emptyText="該当はありません。" />
      </section>
      <section className="card rp-report" aria-label="期間外の売上">
        <h3>期間外の売上</h3>
        {body.salesDenied ? <p className="rp-muted">売上は財務の権限（案件の編集権限）がある作品だけ照合します。</p> : (
          <>
            <p className="rp-muted">売上明細の取引先（またはリストの請求先）・作品（商品の作品配賦）・流通（最新の流通分類。無ければ報告の種類で参考に）・期間で、取引先のリストの明細と照合します。止めずに印を付けるだけです。</p>
            <div className="rw-filters" role="search" aria-label="期間外の売上の条件">
              <FormField type="select" label="期間の比べ方" includeBlank={false} value={basis} onChange={(value) => set('basis', value === 'month' ? null : value)} options={Object.entries(PERIOD_BASES).map(([value, label]) => ({value, label}))} />
              <FormField type="month" label="計上月（から）" value={from || sales.from} onChange={(value) => set('from', /^\d{4}-\d{2}$/.test(value) ? value : null)} />
              <FormField type="month" label="計上月（まで）" value={to || sales.to} onChange={(value) => set('to', /^\d{4}-\d{2}$/.test(value) ? value : null)} />
              <FormField type="select" label="照合の結果" value={status} blankLabel="期間外と流通違い" onChange={(value) => set('sstatus', value)} options={Object.entries(SALE_MATCH).map(([value, label]) => ({value, label}))} />
            </div>
            <p className="rp-meta" aria-live="polite">
              <span>照合した売上 {int(sales.scanned)}件</span>
              {Object.entries(sales.counts).filter(([, n]) => n > 0).map(([key, n]) => <span key={key} className={['before_start', 'after_end', 'gap', 'no_contract'].includes(key) ? 'pl-excl-text' : ''}>{SALE_MATCH[key]} {int(n)}</span>)}
              {sales.skipped > 0 && <span>財務の権限が無い作品の売上 {int(sales.skipped)}件は照合していません</span>}
            </p>
            <DataGrid columns={saleColumns} rows={sales.rows.map((row) => ({...row, key: `${row.sale_id}-${row.work_id}`}))} rowKey="key" persistKey="partner-list-sales" ariaLabel="期間外の売上" maxHeight="50vh"
              emptyText="該当する売上はありません。" />
          </>
        )}
      </section>
    </div>
  );
}

// ---- 追加の列 ------------------------------------------------------------------------------------------
function FieldsTab({request, meta, onChanged}) {
  const shell = useShell();
  const [state, setState] = useState({loading: true});
  const [revision, setRevision] = useState(0);
  const [draft, setDraft] = useState({fieldKey: '', label: '', valueType: 'text', listKind: '', partnerId: '', options: '', sortOrder: '1000', reason: ''});
  const [notice, setNotice] = useState(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let live = true;
    request('/partner-list-fields').then((body) => { if (live) setState({body}); }).catch((error) => { if (live) setState({error}); });
    return () => { live = false; };
  }, [request, revision]);
  const body = state.body;
  const canAdmin = Boolean(body?.canAdmin) && !shell.readOnly;
  const update = (key, value) => setDraft((p) => ({...p, [key]: value}));
  async function create(event) {
    event.preventDefault();
    setBusy(true);
    try {
      await request('/partner-list-fields', {method: 'POST', body: JSON.stringify({...draft, listKind: draft.listKind || null, partnerId: draft.partnerId || null})});
      setNotice({tone: 'ok', message: `追加の列「${draft.label}」を足しました。テンプレートの見出しと明細の表に列が増えます`});
      setDraft({fieldKey: '', label: '', valueType: 'text', listKind: '', partnerId: '', options: '', sortOrder: '1000', reason: ''});
      setRevision((n) => n + 1);
      onChanged?.();
    } catch (error) {
      setNotice({error});
    } finally {
      setBusy(false);
    }
  }
  const [pending, setPending] = useState(null);
  async function toggle(event) {
    event.preventDefault();
    const field = pending.field;
    setBusy(true);
    try {
      await request(`/partner-list-fields/${field.id}/versions`, {method: 'POST', body: JSON.stringify({baseVersion: field.version_no, active: !field.active, reason: pending.reason})});
      setNotice({tone: 'ok', message: `「${field.label}」を${field.active ? 'やめました（登録済みの値は版に残ります）' : '使うようにしました'}`});
      setPending(null);
      setRevision((n) => n + 1);
      onChanged?.();
    } catch (error) {
      setNotice({error});
    } finally {
      setBusy(false);
    }
  }
  const columns = [
    {key: 'label', label: '表示名（見出し）', type: 'text', sticky: true}, {key: 'field_key', label: 'キー', type: 'code'},
    {key: 'value_type', label: '型', type: 'text', value: (row) => FIELD_VALUE_TYPES[row.value_type]}, {key: 'scope_text', label: '使うリスト', type: 'text'},
    {key: 'options', label: '選択肢', type: 'text', value: (row) => (row.options || []).join('・') || null, render: (row) => dash((row.options || []).join('・'))}, {key: 'active', label: '使う', type: 'text', value: (row) => (row.active ? '使う' : 'やめた')},
    {key: 'version_no', label: '版', type: 'int', total: 'none'},
    ...(canAdmin ? [{key: 'action', label: '操作', type: 'text', export: false, sortable: false, value: () => null, render: (row) => <button type="button" className="secondary" onClick={() => setPending({field: row, reason: ''})}>{row.active ? 'やめる' : '使う'}</button>}] : []),
  ];
  return (
    <section className="card rw-section" aria-label="追加の列">
      <p className="rp-muted">固定の列で足りない項目（セール実施期間・視聴期間など）を列として足します。全取引先・リストの種類・1つの取引先のどれで使うかを選べます。定義と変更は管理者が理由を書いて行い、版と監査記録に残ります。</p>
      {state.error && <Notice error={state.error} />}
      {notice && <Notice tone={notice.tone} message={notice.message} error={notice.error} onDismiss={() => setNotice(null)} />}
      {body && <DataGrid columns={columns} rows={body.fields} rowKey="id" ariaLabel="追加の列の一覧" showTotals={false} maxHeight="40vh" emptyText="追加の列はまだありません。" />}
      {pending && (
        <form className="rw-editor pl-reason-form" onSubmit={toggle} aria-label={`${pending.field.label}を${pending.field.active ? 'やめる' : '使う'}`}>
          <FormField label={`「${pending.field.label}」を${pending.field.active ? 'やめる' : '使う'}理由`} required value={pending.reason} onChange={(value) => setPending((p) => ({...p, reason: value}))} />
          <button type="submit" disabled={busy || !pending.reason.trim()}>{pending.field.active ? 'この列をやめる' : 'この列を使う'}</button>
          <button type="button" className="secondary" onClick={() => setPending(null)}>やめる</button>
        </form>
      )}
      {canAdmin && (
        <form className="rw-type-form" onSubmit={create} aria-label="追加の列を足す">
          <div className="rw-field-row">
            <FormField label="キー（英小文字）" required value={draft.fieldKey} onChange={(value) => update('fieldKey', value)} hint="例: sale_window" />
            <FormField label="表示名（見出し）" required value={draft.label} onChange={(value) => update('label', value)} />
            <FormField type="select" label="型" includeBlank={false} value={draft.valueType} onChange={(value) => update('valueType', value)} options={Object.entries(FIELD_VALUE_TYPES).map(([value, label]) => ({value, label}))} />
            <FormField type="select" label="リストの種類" value={draft.listKind} blankLabel="すべて" onChange={(value) => update('listKind', value)} options={meta.kinds.map((k) => ({value: k.code, label: k.label}))} />
            <FormField type="select" label="取引先" value={draft.partnerId} blankLabel="すべて" onChange={(value) => update('partnerId', value)} options={meta.partners.map((p) => ({value: String(p.id), label: `${p.code}｜${p.name}`}))} />
            {draft.valueType === 'choice' && <FormField label="選択肢（カンマ区切り）" required value={draft.options} onChange={(value) => update('options', value)} />}
            <FormField type="int" label="並び順" value={draft.sortOrder} onChange={(value) => update('sortOrder', value)} />
          </div>
          <FormField type="textarea" label="理由" required rows={2} value={draft.reason} onChange={(value) => update('reason', value)} />
          <div className="rw-editor-buttons"><button type="submit" disabled={busy || !draft.fieldKey.trim() || !draft.label.trim() || !draft.reason.trim()}>追加の列を足す</button></div>
        </form>
      )}
    </section>
  );
}

// ---- 画面 ------------------------------------------------------------------------------------------------
export function PartnerListsPage({request: requestProp}) {
  const shell = useShell();
  const request = useRequest(requestProp);
  const [read, set] = useParams(shell);
  const asOf = read('asof') || todayJst();
  const soonDays = SOON_DAYS.includes(Number(read('soon'))) ? Number(read('soon')) : 30;
  const [state, setState] = useState({loading: true});
  const [revision, setRevision] = useState(0);
  const reload = () => setRevision((n) => n + 1);
  useEffect(() => {
    let live = true;
    request(`/partner-lists?asOf=${asOf}&soonDays=${soonDays}`).then((body) => { if (live) setState({body}); }).catch((error) => { if (live) setState({error}); });
    return () => { live = false; };
  }, [request, asOf, soonDays, revision]);
  const meta = state.body;
  return (
    <div className="so-page">
      <section className="card rw-section pl-head" aria-label="基準日と出力">
        <p className="rp-muted">取引先ごとの配信リスト・販売リストに、作品×流通IDの契約期間を明細として持ちます。状態は基準日から計算します。全取引先で同じ形式の Excel で取り込み、全取引先をまとめた表として出力します。</p>
        <div className="rw-filters">
          <FormField type="date" label="基準日" value={asOf} onChange={(value) => set('asof', /^\d{4}-\d{2}-\d{2}$/.test(value) && value !== todayJst() ? value : null)} />
          <FormField type="select" label="終了間近の日数" includeBlank={false} value={String(soonDays)} onChange={(value) => set('soon', value === '30' ? null : value)} options={SOON_DAYS.map((n) => ({value: String(n), label: `${n}日以内`}))} />
          <a className="bc-link-button rw-link-button" href={`/api/partner-lists/export?asOf=${asOf}&soonDays=${soonDays}`} download>全取引先をまとめて出力（Excel）</a>
          <a className="bc-link-button rw-link-button" href={`/api/partner-lists/export?asOf=${asOf}&soonDays=${soonDays}&format=csv`} download>CSV</a>
        </div>
      </section>
      {state.error && <Notice error={state.error} onRetry={reload} />}
      {state.loading && !meta && <p className="rp-muted" aria-busy="true">読み込み中…</p>}
      {meta && (
        <Tabs urlKey={`${P}tab`} label="取引先リストの見方" tabs={[
          {id: 'lists', label: '取引先別リスト', badge: meta.lists.length},
          {id: 'matrix', label: '作品×取引先'},
          {id: 'checks', label: '確認'},
          {id: 'fields', label: '追加の列', badge: meta.fields.filter((f) => f.active).length || undefined},
        ]}>
          {(active) => (active === 'matrix' ? <MatrixTab request={request} meta={meta} asOf={asOf} soonDays={soonDays} />
            : active === 'checks' ? <ChecksTab request={request} asOf={asOf} />
              : active === 'fields' ? <FieldsTab request={request} meta={meta} onChanged={reload} />
                : <ListsTab request={request} meta={meta} asOf={asOf} soonDays={soonDays} onChanged={reload} />)}
        </Tabs>
      )}
    </div>
  );
}

export default PartnerListsPage;
