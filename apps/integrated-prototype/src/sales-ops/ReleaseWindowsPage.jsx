// 営業基幹の最初の画面「全作品のウィンドウ」。表（ReleaseWindowGrid）・Excel の取込・ウィンドウの種別（管理者が採用・追加・変更）。
// Excel は表と同じ列の並びで出力し、同じ形で取り込む（確認 → 理由を書いて登録）。取り込めるのは案件の編集権限がある作品だけ。
import React, {useCallback, useEffect, useId, useMemo, useRef, useState} from 'react';
import {useShell} from '../shell/context.mjs';
import {DataGrid} from '../ui/DataGrid.jsx';
import {Notice} from '../ui/Notice.jsx';
import {FormField} from '../ui/FormField.jsx';
import {int} from '../ui/format.mjs';
import {decodeXlsx} from '../xlsx.mjs';
import {downloadReportXlsx, reportBaseName} from '../xlsx-report.mjs';
import {ReleaseWindowGrid} from './ReleaseWindowGrid.jsx';
import {SalesSheetLink, useSalesSheetAccess} from '../sales-sheet/SalesSheetLink.jsx';
import {WINDOW_FAMILIES, VALUE_TYPES, CHOICE_DOMAINS, tableFromWindowSheets, failedWindowRows, typeParts, headerOf} from './release-window-model.mjs';
import './release-windows.css';
import './proposals.css';

const ACTION_LABELS = {append: '追加あり', revise: '改訂', unchanged: '変更なし', error: 'エラー'};

function useRequest(requestProp) {
  const shell = useShell();
  const ref = useRef(null);
  ref.current = requestProp || shell.request;
  return useCallback((path, options) => ref.current(path, options), []);
}

// ---- Excel の取込 ------------------------------------------------------------------------
export function ReleaseWindowImport({request: requestProp, onCommitted}) {
  const shell = useShell();
  const request = useRequest(requestProp);
  const readOnly = Boolean(shell.readOnly);
  const inputId = useId();
  const [inputKey, setInputKey] = useState(0);
  const [upload, setUpload] = useState(null);
  const [preview, setPreview] = useState(null);
  const [notice, setNotice] = useState(null);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    shell.registerUnsaved('release-window-import', preview?.token ? 1 : 0, 'ウィンドウの Excel 取込（確認中）');
    return () => shell.registerUnsaved('release-window-import', 0);
  }, [preview]); // eslint-disable-line react-hooks/exhaustive-deps

  async function runPreview(next) {
    setBusy(true);
    setPreview(null);
    try {
      const result = await request('/release-windows/import/preview', {method: 'POST', body: JSON.stringify({table: next.table, fileName: next.fileName})});
      setPreview(result);
      const {counts} = result;
      setNotice(result.token
        ? {tone: result.warnings?.length ? 'warn' : 'info', title: `${next.fileName} の内容（まだ登録していません）`,
          message: `追加 ${counts.windowsAppend}件・改訂 ${counts.windowsRevise}件のウィンドウ（${counts.rows}行のうち変更のある作品 ${counts.append + counts.revise}行・変更なし ${counts.unchanged}行）。理由を書いて「この内容で登録する」を押してください`,
          details: (result.warnings || []).map((message) => ({message}))}
        : {tone: 'info', title: `${next.fileName} の内容`, message: `変更はありません（${counts.rows}行すべて今の版と同じです）`, details: (result.warnings || []).map((message) => ({message}))});
    } catch (error) {
      const body = error?.body && typeof error.body === 'object' ? error.body : null;
      setNotice({error, failed: body?.failedRows?.length ? body : null, fileName: next.fileName, rows: body?.rows || null});
    } finally {
      setBusy(false);
    }
  }

  async function choose(event) {
    const file = event.target.files?.[0];
    if (!file) return;
    try {
      if (!/\.xlsx$/i.test(file.name)) throw new Error('出力した Excel（.xlsx）を選んでください。.xls（古い形式）や CSV は Excel で .xlsx に保存し直してください');
      const table = tableFromWindowSheets(decodeXlsx(new Uint8Array(await file.arrayBuffer()), {formulas: 'sheet'}));
      const next = {fileName: file.name, table};
      setUpload(next);
      await runPreview(next);
    } catch (error) {
      setUpload(null);
      setPreview(null);
      setNotice({error});
    }
  }

  async function commit() {
    setBusy(true);
    try {
      const result = await request('/release-windows/import/commit', {method: 'POST', body: JSON.stringify({token: preview.token, reason, confirmed: true, fileName: upload?.fileName || ''})});
      shell.registerUnsaved('release-window-import', 0);
      setPreview(null);
      setUpload(null);
      setReason('');
      setInputKey((n) => n + 1);
      setNotice({tone: 'ok', message: `ウィンドウを登録しました（追加 ${result.append}件・改訂 ${result.revise}件）`});
      onCommitted?.();
    } catch (error) {
      setNotice({error, expired: error?.status === 410});
    } finally {
      setBusy(false);
    }
  }

  function cancel() {
    setPreview(null);
    setUpload(null);
    setReason('');
    setNotice(null);
    setInputKey((n) => n + 1);
  }

  function downloadFailed() {
    const failed = notice?.failed;
    if (!failed) return;
    const {columns, rows} = failedWindowRows({headers: failed.headers || [], rows: failed.failedRows.map((row) => ({...row, errors: row.errors || []}))});
    downloadReportXlsx(reportBaseName('全作品のウィンドウ_登録できない行'), {sheets: [{name: '失敗行', titleBand: false, freezeCols: 1, columns, rows}]});
  }

  const rows = (preview?.rows || notice?.rows || []).filter((row) => row.action !== 'unchanged');
  const columns = useMemo(() => [
    {key: 'rowNo', label: '行', type: 'int', total: 'none', sticky: true},
    {key: 'workCode', label: '作品コード', type: 'code'},
    {key: 'workTitle', label: '作品', type: 'text'},
    {key: 'action', label: '扱い', type: 'text', value: (row) => ACTION_LABELS[row.action] || row.action},
    {key: 'changes', label: '変わる種別と項目', type: 'text', wrap: true, value: (row) => (row.changes || []).map((c) => `${c.typeLabel}（${c.action === 'append' ? '新規' : '改訂'}: ${c.parts.join('・')}）`).join(' ／ ') || '—'},
    {key: 'errors', label: 'エラー', type: 'text', wrap: true, value: (row) => (row.errors || []).join(' ／ ') || '—'},
  ], []);

  return (
    <section className="card rw-section" aria-label="ウィンドウの Excel 取込">
      <header>
        <h3>Excel で直して取り込む</h3>
        <p className="rp-muted">上の「Excelで出力」で出したファイルを直して読み込みます。作品コードで照合し、「参考_」の列と知らない見出しの列は読みません。無い列は変更せず、ある列の空欄は空にします。確認の表を見てから、理由を書いて登録します（版を1つずつ積みます）。</p>
      </header>
      {!readOnly && (
        <div className="rw-upload">
          <label htmlFor={inputId}>直した Excel（.xlsx）を読み込む</label>
          <input key={inputKey} id={inputId} type="file" disabled={busy} accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" onChange={choose} />
          {busy && <span className="rp-muted" role="status">確認しています…</span>}
        </div>
      )}
      {notice && (
        <Notice tone={notice.tone} title={notice.title} message={notice.message} details={notice.details} error={notice.error}
          onRetry={notice.expired && upload ? () => runPreview(upload) : undefined} retryLabel="もう一度確認する"
          actions={notice.failed ? <button type="button" className="secondary" onClick={downloadFailed}>エラーの行をExcelで受け取る</button> : undefined}
          onDismiss={() => setNotice(null)} />
      )}
      {rows.length > 0 && <DataGrid columns={columns} rows={rows} rowKey="rowNo" ariaLabel="取込内容の確認" maxHeight="45vh" showTotals={false} />}
      {preview?.token && (
        <div className="rw-editor">
          <FormField type="textarea" label="取込の理由" required rows={2} value={reason} onChange={setReason} hint="登録する各版の理由と監査記録に残ります" />
          <div className="rw-editor-buttons">
            <button type="button" disabled={busy || !reason.trim()} onClick={commit}>この内容で登録する</button>
            <button type="button" className="secondary" disabled={busy} onClick={cancel}>取り消す</button>
          </div>
        </div>
      )}
    </section>
  );
}

// ---- ウィンドウの種別 ----------------------------------------------------------------------
const emptyType = () => ({type_key: '', label: '', group_label: '', family: 'digital', date_mode: 'period', start_label: '解禁日', end_label: '配信期限', has_announce: true,
  default_territory: '日本', sort_order: '1000', distributions: '', fields: [], reason: ''});

function TypeForm({request, initial, existing, onSaved, onCancel}) {
  const [draft, setDraft] = useState(() => initial || emptyType());
  const [notice, setNotice] = useState(null);
  const [busy, setBusy] = useState(false);
  const update = (key, value) => setDraft((previous) => ({...previous, [key]: value}));
  const updateField = (index, key, value) => setDraft((previous) => ({...previous, fields: previous.fields.map((field, i) => (i === index ? {...field, [key]: value} : field))}));
  async function submit(event) {
    event.preventDefault();
    setBusy(true);
    setNotice(null);
    const payload = {...draft, has_announce: Boolean(draft.has_announce), sort_order: Number(draft.sort_order), active: draft.active !== false,
      distributions: String(draft.distributions || '').split(/[,、\s]+/).map((code) => code.trim()).filter(Boolean),
      fields: draft.fields.map((field, index) => ({...field, sort_order: (index + 1) * 10, choice_domain: field.value_type === 'choice' ? field.choice_domain || 'exclusivity' : null}))};
    try {
      if (existing) await request(`/release-window-types/${existing.id}/versions`, {method: 'POST', body: JSON.stringify({...payload, baseVersion: existing.version_no})});
      else await request('/release-window-types', {method: 'POST', body: JSON.stringify(payload)});
      onSaved?.(existing ? `「${draft.label}」の新しい版を登録しました` : `種別「${draft.label}」を追加しました。表と Excel の見出しに列が増えます`);
    } catch (error) {
      setNotice({error});
    } finally {
      setBusy(false);
    }
  }
  return (
    <form className="rw-type-form" onSubmit={submit} aria-label={existing ? `${existing.label}の新しい版` : '種別を追加'}>
      <div className="rw-field-row">
        {!existing && <FormField label="種別キー（英小文字）" required value={draft.type_key} onChange={(value) => update('type_key', value)} hint="例: svod_third" />}
        <FormField label="表示名" required value={draft.label} onChange={(value) => update('label', value)} hint="Excel の見出しの頭になります" />
        <FormField label="まとまり" value={draft.group_label} onChange={(value) => update('group_label', value)} />
        <FormField type="select" label="分類" includeBlank={false} value={draft.family} onChange={(value) => update('family', value)} options={Object.entries(WINDOW_FAMILIES).map(([value, label]) => ({value, label}))} />
        <FormField type="select" label="日付の形" includeBlank={false} value={draft.date_mode} onChange={(value) => update('date_mode', value)} options={[{value: 'period', label: '期間（解禁〜期限）'}, {value: 'point', label: '1日（公開日・発売日）'}]} />
        <FormField label="開始の見出し" value={draft.start_label} onChange={(value) => update('start_label', value)} />
        {draft.date_mode === 'period' && <FormField label="終了の見出し" value={draft.end_label || ''} onChange={(value) => update('end_label', value)} />}
        <FormField label="既定の地域" value={draft.default_territory} onChange={(value) => update('default_territory', value)} />
        <FormField type="int" label="並び順" value={String(draft.sort_order)} onChange={(value) => update('sort_order', value)} />
        <FormField label="対応する流通ID（カンマ区切り）" value={draft.distributions} onChange={(value) => update('distributions', value)} hint="例: D005, svod。販売条件の期間外の警告に使います" />
      </div>
      <label className="dg-check"><input type="checkbox" checked={Boolean(draft.has_announce)} onChange={(event) => update('has_announce', event.target.checked)} />告知解禁日を持つ</label>
      {existing && <label className="dg-check"><input type="checkbox" checked={draft.active !== false} onChange={(event) => update('active', event.target.checked)} />この種別を使う（外すと表と Excel から列が消えます。登録済みの版は残ります）</label>}
      <fieldset>
        <legend>追加項目</legend>
        {draft.fields.map((field, index) => (
          <div className="rw-field-row" key={index}>
            <FormField label="キー" value={field.field_key} onChange={(value) => updateField(index, 'field_key', value)} />
            <FormField label="表示名" value={field.label} onChange={(value) => updateField(index, 'label', value)} />
            <FormField type="select" label="型" includeBlank={false} value={field.value_type} onChange={(value) => updateField(index, 'value_type', value)} options={Object.entries(VALUE_TYPES).map(([value, label]) => ({value, label}))} />
            {field.value_type === 'choice' && <FormField type="select" label="選択肢" includeBlank={false} value={field.choice_domain || 'exclusivity'} onChange={(value) => updateField(index, 'choice_domain', value)}
              options={Object.entries(CHOICE_DOMAINS).map(([value, labels]) => ({value, label: Object.values(labels).join('・')}))} />}
            <button type="button" className="secondary" onClick={() => setDraft((previous) => ({...previous, fields: previous.fields.filter((_, i) => i !== index)}))}>この項目を外す</button>
          </div>
        ))}
        <div><button type="button" className="secondary" onClick={() => setDraft((previous) => ({...previous, fields: [...previous.fields, {field_key: '', label: '', value_type: 'text', choice_domain: null}]}))}>＋追加項目</button></div>
      </fieldset>
      <FormField type="textarea" label="理由" required rows={2} value={draft.reason} onChange={(value) => update('reason', value)} />
      {notice && <Notice error={notice.error} onDismiss={() => setNotice(null)} />}
      <div className="rw-editor-buttons">
        <button type="submit" disabled={busy}>{existing ? `第${existing.version_no + 1}版を登録する` : '種別を追加する'}</button>
        <button type="button" className="secondary" disabled={busy} onClick={onCancel}>やめる</button>
      </div>
    </form>
  );
}

export function ReleaseWindowTypes({request: requestProp, onChanged}) {
  const shell = useShell();
  const request = useRequest(requestProp);
  const readOnly = Boolean(shell.readOnly);
  const [state, setState] = useState({loading: true});
  const [revision, setRevision] = useState(0);
  const [adding, setAdding] = useState(false);
  const [reason, setReason] = useState('');
  const [notice, setNotice] = useState(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let live = true;
    request('/release-window-types').then((body) => { if (live) setState({body}); }).catch((error) => { if (live) setState({error}); });
    return () => { live = false; };
  }, [request, revision]);
  const body = state.body;
  const changed = (message) => { setNotice({tone: 'ok', message}); setAdding(false); setRevision((n) => n + 1); onChanged?.(); };
  async function adopt() {
    setBusy(true);
    try {
      const result = await request('/release-window-types/adopt', {method: 'POST', body: JSON.stringify({reason})});
      setReason('');
      changed(`初期の種別 ${result.adopted}種を採用しました`);
    } catch (error) {
      setNotice({error});
    } finally {
      setBusy(false);
    }
  }
  const columns = [
    {key: 'label', label: '種別', type: 'text', sticky: true},
    {key: 'group_label', label: 'まとまり', type: 'text'},
    {key: 'family', label: '分類', type: 'text', value: (row) => WINDOW_FAMILIES[row.family]},
    {key: 'date_mode', label: '日付の形', type: 'text', value: (row) => (row.date_mode === 'point' ? '1日' : '期間')},
    {key: 'headers', label: 'Excel の見出し', type: 'text', wrap: true, value: (row) => typeParts(row).map((part) => headerOf(row, part)).join('、')},
    {key: 'distributions', label: '対応する流通ID', type: 'text', wrap: true, value: (row) => row.distributions.join('、') || '—'},
    {key: 'default_territory', label: '既定の地域', type: 'text'},
    {key: 'sort_order', label: '並び順', type: 'int', total: 'none'},
    {key: 'active', label: '使う', type: 'text', value: (row) => (row.active ? '使う' : 'やめた')},
    {key: 'version_no', label: '版', type: 'int', total: 'none'},
  ];
  const canAdmin = Boolean(body?.canAdmin) && !readOnly;
  return (
    <details className="card rw-section rw-types" open={Boolean(body && !body.types.length)}>
      <summary>ウィンドウの種別（{body ? `${int(body.types.filter((t) => t.active).length)}種を使用中` : '読み込み中'}・追加と変更は管理者）</summary>
      <p className="rp-muted">種別を1つ足すと、次の読み込みで表の列と Excel の見出しが増えます。種別の追加・変更は理由を書いて版を積み、監査記録に残します。劇場は「劇場公開・配給開始」の1種別です。</p>
      {state.error && <Notice error={state.error} onRetry={() => setRevision((n) => n + 1)} />}
      {notice && <Notice tone={notice.tone} message={notice.message} error={notice.error} onDismiss={() => setNotice(null)} />}
      {body?.canAdopt && !readOnly && (
        <div className="rw-type-form">
          <p>初期の種別 {body.templates.length}種（{body.templates.map((t) => t.label).join('・')}）を、この組織の種別として採用します。</p>
          <FormField type="textarea" label="採用の理由" required rows={2} value={reason} onChange={setReason} />
          <div className="rw-editor-buttons"><button type="button" disabled={busy || !reason.trim()} onClick={adopt}>初期の種別を採用する</button></div>
        </div>
      )}
      {body && body.types.length > 0 && (
        <DataGrid columns={columns} rows={body.types} rowKey="id" persistKey="release-window-types" ariaLabel="ウィンドウの種別" showTotals={false} maxHeight="50vh"
          renderDetail={canAdmin ? (row) => (
            <TypeForm request={request} existing={row} initial={{...row, distributions: row.distributions.join(', '), sort_order: String(row.sort_order), fields: row.fields.map((f) => ({...f})), reason: ''}}
              onSaved={changed} onCancel={() => setRevision((n) => n + 1)} />
          ) : undefined} />
      )}
      {canAdmin && body?.types.length > 0 && (adding
        ? <TypeForm request={request} onSaved={changed} onCancel={() => setAdding(false)} />
        : <div><button type="button" className="secondary" onClick={() => setAdding(true)}>＋種別を追加</button></div>)}
    </details>
  );
}

export function ReleaseWindowsPage({request}) {
  const shell = useShell();
  const [revision, setRevision] = useState(0);
  const bump = () => setRevision((n) => n + 1);
  // 財務の権限がある人には、行からその作品の売上集計シートを開くリンクを出す
  const access = useSalesSheetAccess(request);
  const rowAction = useCallback((row) => <SalesSheetLink access={access} workId={row.work_id} />, [access]);
  return (
    <div className="so-page">
      <nav className="card pp-entry" aria-label="提案資料への入口">
        <p>この表のウィンドウから、PVOD・TVOD・EST の月別の提案資料と SVOD の提案資料を Excel で出せます。</p>
        <button type="button" className="secondary" onClick={() => shell.navigate('提案資料')}>提案資料を出す</button>
      </nav>
      <ReleaseWindowGrid request={request} revision={revision} showTitle={false} rowAction={access?.canOpen ? rowAction : undefined} />
      <ReleaseWindowImport request={request} onCommitted={bump} />
      <ReleaseWindowTypes request={request} onChanged={bump} />
    </div>
  );
}

export default ReleaseWindowsPage;
