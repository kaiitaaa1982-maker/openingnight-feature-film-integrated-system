// 全作品のウィンドウの表（営業基幹の最初の画面と、番販・放送の「番販作品一覧」タブで共通）。
// 1行1作品（ウィンドウが無い作品も「未登録」）。種別ごとに列のまとまり（2段の見出し）を持ち、見せ方は「日付だけ」と「全項目」。
// 絞り込み（種別・状態・期間・語句・警告のあるものだけ）はサーバー側で行い、100行ずつ送る。条件は URL（rw*）に残す。
// セル（日付）を押すと、その作品×種別の版の履歴と新しい版の入力を行の下に開く。警告はその場で計算した注意で、登録は止めない。
// 使い方: <ReleaseWindowGrid /> ／ 番販: <ReleaseWindowGrid families={['broadcast','digital']} persistKey="broadcast-windows" rowAction={...} />
import React, {useCallback, useEffect, useMemo, useRef, useState} from 'react';
import {useShell} from '../shell/context.mjs';
import {DataGrid} from '../ui/DataGrid.jsx';
import {Notice} from '../ui/Notice.jsx';
import {FormField} from '../ui/FormField.jsx';
import {int, dateTimeJst} from '../ui/format.mjs';
import {
  WINDOW_FAMILIES, WINDOW_STATES, DATE_FIELDS, CHOICE_DOMAINS, DATE_PRECISIONS, PAGE_SIZE,
  startText, dateText, fieldText, currentWindowInput,
} from './release-window-model.mjs';
import '../reports/reports.css';
import './sales-ops.css';
import './release-windows.css';

const STATE_TONE = {unregistered: 'none', draft: 'info', confirmed: 'ok', withdrawn: 'muted'};
const P = 'rw'; // URL の条件の接頭辞（同じ画面のほかの条件とぶつからないように）

export function StateBadge({state}) {
  return <span className={`rw-state rw-state-${STATE_TONE[state] || 'none'}`}>{WINDOW_STATES[state] || state}</span>;
}

// 条件（URL）→ API の問い合わせ
export function windowQuery(params, {families} = {}) {
  const search = new URLSearchParams();
  const fam = families?.length ? families.join(',') : params.fam;
  if (fam) search.set('families', fam);
  for (const [param, key] of [['type', 'types'], ['state', 'state'], ['date', 'dateField'], ['from', 'from'], ['to', 'to'], ['q', 'q']]) if (params[param]) search.set(key, params[param]);
  if (params.warn === '1') search.set('warnings', '1');
  if (params.page && params.page !== '1') search.set('page', params.page);
  return search.toString();
}

function useWindowParams(shell) {
  const read = (key) => shell.getParam(`${P}${key}`, '') || '';
  const params = {fam: read('fam'), type: read('type'), state: read('state'), date: read('date'), from: read('from'), to: read('to'), q: read('q'), warn: read('warn'), page: read('page'), view: read('view') || 'dates'};
  const set = (key, value) => {
    shell.setParam(`${P}${key}`, value || null, {replace: true});
    if (key !== 'page' && key !== 'view') shell.setParam(`${P}page`, null, {replace: true});
  };
  return [params, set];
}

// ---- 版の履歴と新しい版 ------------------------------------------------------------------
// 今の版から作る下書き。種別の最新の版にある部分だけを持つ（種別を直した後に残った告知・終了・外した追加項目は持ち越さない）
function emptyDraft(version, type) {
  const input = currentWindowInput(version, type);
  return {
    start: input.start || '', end: input.end || '', announce: input.announce || '', status: input.status || 'draft', fields: input.fields,
    availabilityVersionId: version?.availability_version_id ? String(version.availability_version_id) : '', sourceKind: 'manual', sourceReference: '', reason: '',
  };
}

function WindowEditor({request, type, workId, history, readOnly, onSaved}) {
  const shell = useShell();
  const current = history.versions[0] || null;
  const [draft, setDraft] = useState(() => emptyDraft(current, type));
  const [notice, setNotice] = useState(null);
  const [busy, setBusy] = useState(false);
  const dirty = JSON.stringify(draft) !== JSON.stringify(emptyDraft(current, type));
  const unsavedId = `release-window-${workId}-${type.id}`;
  useEffect(() => {
    shell.registerUnsaved(unsavedId, dirty ? 1 : 0, `${type.label}の新しい版（入力中）`);
    return () => shell.registerUnsaved(unsavedId, 0);
  }, [dirty]); // eslint-disable-line react-hooks/exhaustive-deps
  const update = (key, value) => setDraft((previous) => ({...previous, [key]: value}));
  const setField = (key, value) => setDraft((previous) => ({...previous, fields: {...previous.fields, [key]: value}}));
  const availability = history.availabilities.find((a) => String(a.id) === draft.availabilityVersionId) || null;

  function fillFromAvailability() {
    if (!availability) return;
    setDraft((previous) => ({...previous, start: availability.release_on || '', end: type.date_mode === 'period' ? availability.sales_end_on || '' : previous.end, sourceKind: 'from_availability'}));
  }

  async function save(event) {
    event.preventDefault();
    setBusy(true);
    setNotice(null);
    try {
      const result = await request('/release-windows', {method: 'POST', body: JSON.stringify({
        workId, typeId: type.id, territory: history.territory, baseVersion: current?.version_no || 0,
        start: draft.start, end: draft.end, announce: draft.announce, status: draft.status, fields: draft.fields,
        availabilityVersionId: draft.availabilityVersionId || null, sourceKind: draft.sourceKind, sourceReference: draft.sourceReference || null, reason: draft.reason,
      })});
      shell.registerUnsaved(unsavedId, 0);
      onSaved?.(`${type.label}の第${result.version}版を登録しました`);
    } catch (error) {
      setNotice({error});
    } finally {
      setBusy(false);
    }
  }

  if (readOnly || !history.canEdit) return <p className="rp-muted">{history.canEdit ? '確認専用の表示です。' : 'この作品（または使っていない種別）は直せません。案件の編集権限がある人が直します。'}</p>;
  return (
    <form className="rw-editor" onSubmit={save} aria-label={`${type.label}の新しい版`}>
      <h5>新しい版（第{(current?.version_no || 0) + 1}版）</h5>
      <p className="rp-muted">日付は 2026-11-05（日付）・2026-11（月まで）・2026（年まで）で入れます。「2027年春」のような時期は原文のまま、「未定」は未定として登録します（仮の日付は作りません）。</p>
      <div className="rw-editor-grid">
        <FormField label={type.start_label} value={draft.start} onChange={(value) => update('start', value)} placeholder="例: 2026-11-05 ／ 2026-11 ／ 2027年春" />
        {type.date_mode === 'period' && <FormField label={type.end_label} value={draft.end} onChange={(value) => update('end', value)} placeholder="例: 2027-12-31 ／ 2027-12" />}
        {type.has_announce ? <FormField label="告知解禁日" value={draft.announce} onChange={(value) => update('announce', value)} placeholder="例: 2026-10-01" /> : null}
        <FormField type="select" label="状態" value={draft.status} includeBlank={false} onChange={(value) => update('status', value)}
          options={['draft', 'confirmed', 'withdrawn'].map((code) => ({value: code, label: WINDOW_STATES[code]}))} />
        {type.fields.map((field) => (field.value_type === 'choice'
          ? <FormField key={field.field_key} type="select" label={field.label} value={draft.fields[field.field_key] ?? ''} blankLabel="未入力" onChange={(value) => setField(field.field_key, value)}
            options={Object.entries(CHOICE_DOMAINS[field.choice_domain] || {}).map(([value, label]) => ({value, label}))} />
          : <FormField key={field.field_key} type={field.value_type === 'yen' ? 'yen' : field.value_type === 'integer' ? 'int' : 'text'} label={field.label}
            value={draft.fields[field.field_key] === undefined || draft.fields[field.field_key] === null ? '' : String(draft.fields[field.field_key])} onChange={(value) => setField(field.field_key, value)} />))}
      </div>
      <div className="rw-editor-grid">
        <FormField type="select" label="根拠にした販売条件の版（任意）" value={draft.availabilityVersionId} blankLabel="結び付けない" onChange={(value) => update('availabilityVersionId', value)}
          options={history.availabilities.map((a) => ({value: String(a.id), label: `${a.distribution_code}・${a.territory}・第${a.version_no}版（${dateText(a.release_on) || '解禁未定'}〜${dateText(a.sales_end_on) || '終了未定'}・${a.status === 'confirmed' ? '条件確認済み' : a.status === 'withdrawn' ? '取り下げ' : '条件未確定'}）`}))}
          hint={history.availabilities.length ? '結び付けても日付は写しません。写すときは右のボタンを押します' : '対応する流通IDの販売条件はまだありません'} />
        {availability && <div className="rw-editor-action"><button type="button" className="secondary" onClick={fillFromAvailability}>この販売条件の日付を入れる</button></div>}
        <FormField label="根拠（資料・メールなど）" value={draft.sourceReference} onChange={(value) => update('sourceReference', value)} />
      </div>
      <FormField type="textarea" label="変更の理由" required rows={2} value={draft.reason} onChange={(value) => update('reason', value)} hint="版の履歴と監査記録に残ります" />
      {notice && <Notice error={notice.error} onDismiss={() => setNotice(null)} />}
      <div className="rw-editor-buttons">
        <button type="submit" disabled={busy || !dirty}>この内容で第{(current?.version_no || 0) + 1}版を登録する</button>
        <button type="button" className="secondary" disabled={busy || !dirty} onClick={() => setDraft(emptyDraft(current, type))}>入力を戻す</button>
      </div>
    </form>
  );
}

function WindowHistory({request, row, type, readOnly, onSaved}) {
  const [state, setState] = useState({loading: true});
  const [revision, setRevision] = useState(0);
  const [message, setMessage] = useState('');
  useEffect(() => {
    let live = true;
    setState((previous) => ({...previous, loading: true}));
    request(`/release-windows/history?workId=${row.work_id}&typeId=${type.id}`)
      .then((body) => { if (live) setState({body}); })
      .catch((error) => { if (live) setState({error}); });
    return () => { live = false; };
  }, [request, row.work_id, type.id, revision]);
  const entry = row.windows?.[type.type_key];
  const history = state.body;
  // 履歴の列は種別の最新の版の部分。種別を直す前の版にだけある値（終了・告知・外した追加項目）は「今は使っていない」列で出す
  const versionColumns = useMemo(() => {
    const current = history?.type || type;
    const versions = history?.versions || [];
    const unused = '（今は使っていない）';
    const showEnd = current.date_mode === 'period' || versions.some((v) => v.end_on);
    const showAnnounce = Boolean(current.has_announce) || versions.some((v) => v.announce_on);
    return [
      {key: 'version_no', label: '版', type: 'int', total: 'none', sticky: true},
      {key: 'start', label: current.start_label, type: 'text', value: (v) => startText(v)},
      ...(showEnd ? [{key: 'end_on', label: current.date_mode === 'period' ? current.end_label : `終了${unused}`, type: 'text', value: (v) => dateText(v.end_on)}] : []),
      ...(showAnnounce ? [{key: 'announce_on', label: current.has_announce ? '告知解禁日' : `告知解禁日${unused}`, type: 'text', value: (v) => dateText(v.announce_on)}] : []),
      {key: 'precision', label: '日付の細かさ', type: 'text', value: (v) => DATE_PRECISIONS[v.date_precision] || v.date_precision},
      ...current.fields.map((field) => ({key: `f:${field.field_key}`, label: field.label, type: 'text', value: (v) => fieldText(field, v.fields?.[field.field_key])})),
      ...(history?.pastFields || []).map((field) => ({key: `f:${field.field_key}`, label: `${field.label}${unused}`, type: 'text', value: (v) => fieldText(field, v.fields?.[field.field_key])})),
      {key: 'status', label: '状態', type: 'text', value: (v) => WINDOW_STATES[v.status], render: (v) => <StateBadge state={v.status} />},
      {key: 'reason', label: '理由', type: 'text', wrap: true},
      {key: 'source', label: '経路・根拠', type: 'text', wrap: true, value: (v) => [{manual: '画面で入力', excel_import: 'Excel取込', from_availability: '販売条件から'}[v.source_kind] || v.source_kind, v.source_reference, v.availability_version_id ? `販売条件の版ID ${v.availability_version_id}` : null].filter(Boolean).join('・')},
      {key: 'created_by_name', label: '登録者', type: 'text'},
      {key: 'created_at', label: '登録日時', type: 'text', value: (v) => dateTimeJst(v.created_at)},
    ];
  }, [type, history]);
  return (
    <section className="rw-history" aria-label={`${row.work_title}・${type.label}`}>
      <header className="rw-history-head">
        <h4>{type.label}<small>{row.work_code}｜{row.work_title}{history ? `｜地域 ${history.territory}` : ''}</small></h4>
        {entry && <StateBadge state={entry.state} />}
      </header>
      {entry?.warnings?.length > 0 && (
        <Notice tone="warn" title="確認してください（登録は止めていません）" details={entry.warnings.map((warning) => ({message: warning.message}))} />
      )}
      {message && <Notice tone="ok" message={message} onDismiss={() => setMessage('')} />}
      {state.error && <Notice error={state.error} onRetry={() => setRevision((n) => n + 1)} />}
      {state.loading && !history && <p className="rp-muted" aria-busy="true">版の履歴を読み込んでいます…</p>}
      {history && (
        <>
          {history.otherTerritories.length > 0 && <p className="rp-muted">ほかの地域の系列: {history.otherTerritories.join('・')}（この表は既定の地域 {history.territory} だけを出します）</p>}
          {history.versions.length
            ? <DataGrid columns={versionColumns} rows={history.versions} rowKey="version_no" ariaLabel={`${type.label}の版の履歴`} showTotals={false} maxHeight="40vh" />
            : <p className="rp-muted">まだ登録がありません（未登録）。</p>}
          <WindowEditor key={`${history.versions[0]?.version_no || 0}`} request={request} type={history.type} workId={row.work_id} history={history} readOnly={readOnly}
            onSaved={(text) => { setMessage(text); setRevision((n) => n + 1); onSaved?.(); }} />
        </>
      )}
    </section>
  );
}

function WindowDetail({request, row, types, selectedKey, onSelect, readOnly, onSaved}) {
  const type = types.find((item) => item.type_key === selectedKey) || null;
  return (
    <div className="rw-detail">
      <div className="rw-type-picker" role="group" aria-label="種別を選ぶ">
        {types.map((item) => {
          const entry = row.windows?.[item.type_key];
          return (
            <button key={item.type_key} type="button" className={`secondary rw-type-button${item.type_key === selectedKey ? ' is-selected' : ''}`} aria-pressed={item.type_key === selectedKey} onClick={() => onSelect(item.type_key)}>
              {item.label}<StateBadge state={entry?.state || 'unregistered'} />{entry?.warnings?.length ? <span className="rw-warn-mark" aria-label={`警告${entry.warnings.length}件`}>⚠</span> : null}
            </button>
          );
        })}
      </div>
      {type ? <WindowHistory key={type.type_key} request={request} row={row} type={type} readOnly={readOnly} onSaved={onSaved} /> : <p className="rp-muted">種別を選ぶと、版の履歴と新しい版の入力が出ます。</p>}
    </div>
  );
}

// ---- 表 -----------------------------------------------------------------------------------
function dateCell(row, type, part, onOpen) {
  const entry = row.windows?.[type.type_key];
  const version = entry?.version;
  const state = entry?.state || 'unregistered';
  const value = part === 'start' ? startText(version) : part === 'end' ? dateText(version?.end_on) : dateText(version?.announce_on);
  const warn = part === 'start' && entry?.warnings?.length > 0;
  const label = part === 'start' ? type.start_label : part === 'end' ? type.end_label : '告知解禁日';
  const shown = state === 'unregistered' ? (part === 'start' ? '未登録' : '') : value || '—';
  return (
    <button type="button" className={`rw-cell rw-cell-${STATE_TONE[state]}${warn ? ' rw-cell-warn' : ''}`} onClick={() => onOpen(row, type)}
      aria-label={`${row.work_title}・${type.label}・${label}: ${shown || '空欄'}（${WINDOW_STATES[state]}）${warn ? `・警告${entry.warnings.length}件` : ''}`}>
      <span>{shown}</span>
      {part === 'start' && (state === 'draft' || state === 'withdrawn') && <small>{WINDOW_STATES[state]}</small>}
      {warn && <span className="rw-warn-mark" aria-hidden="true" title={entry.warnings.map((w) => w.message).join('\n')}>⚠</span>}
    </button>
  );
}

const warningList = (row) => Object.values(row.windows || {}).flatMap((entry) => (entry.warnings || []).map((w) => `${entry.typeLabel}: ${w.message}`));
const warningTypes = (row) => Object.values(row.windows || {}).filter((entry) => entry.warnings?.length).map((entry) => entry.typeLabel);
const dash = (value) => (value === null || value === undefined || value === '' ? <span className="dg-muted">—</span> : value);

export function windowColumns(types, {view = 'dates', onOpen, rowAction} = {}) {
  const all = view === 'all';
  const columns = [
    {key: 'work_code', label: '作品コード', type: 'code', sticky: true},
    {key: 'work_title', label: '作品名', type: 'text', sticky: true, render: (row) => <strong className="rw-work">{row.work_title}</strong>},
    // 警告は横に送らなくても見えるよう固定列の次に置く（件数と種別だけ。内容は日付のセルを押した先に出す）
    {key: 'warnings', label: '警告', type: 'text', value: (row) => warningList(row).join('\n') || null,
      render: (row) => {
        const kinds = warningTypes(row);
        return kinds.length ? <span className="rw-warn-text" title={warningList(row).join('\n')}>⚠ {warningList(row).length}件（{kinds.join('・')}）</span> : dash(null);
      }},
    ...(all ? [{key: 'project_title', label: '案件', type: 'text'}] : []),
  ];
  for (const type of types) {
    const entryOf = (row) => row.windows?.[type.type_key];
    columns.push({key: `${type.type_key}:start`, group: type.label, label: type.start_label, type: 'text', sortable: true,
      value: (row) => entryOf(row)?.version?.start_on || (entryOf(row)?.version ? startText(entryOf(row).version) : null), render: (row) => dateCell(row, type, 'start', onOpen)});
    if (type.date_mode === 'period') columns.push({key: `${type.type_key}:end`, group: type.label, label: type.end_label, type: 'text', value: (row) => entryOf(row)?.version?.end_on || null, render: (row) => dateCell(row, type, 'end', onOpen)});
    if (type.has_announce) columns.push({key: `${type.type_key}:announce`, group: type.label, label: '告知解禁日', type: 'text', value: (row) => entryOf(row)?.version?.announce_on || null, render: (row) => dateCell(row, type, 'announce', onOpen)});
    if (all) {
      for (const field of type.fields) {
        columns.push({key: `${type.type_key}:field:${field.field_key}`, group: type.label, label: field.label, type: 'text', align: ['yen', 'integer'].includes(field.value_type) ? 'right' : undefined,
          value: (row) => fieldText(field, entryOf(row)?.version?.fields?.[field.field_key]) || null, render: (row) => dash(fieldText(field, entryOf(row)?.version?.fields?.[field.field_key]))});
      }
      columns.push({key: `${type.type_key}:status`, group: type.label, label: '状態', type: 'text', value: (row) => WINDOW_STATES[entryOf(row)?.state || 'unregistered'], render: (row) => <StateBadge state={entryOf(row)?.state || 'unregistered'} />});
      columns.push({key: `${type.type_key}:version`, group: type.label, label: '版', type: 'int', total: 'none', value: (row) => entryOf(row)?.version?.version_no ?? null, render: (row) => dash(entryOf(row)?.version?.version_no)});
    }
  }
  if (rowAction) columns.push({key: 'action', label: '操作', type: 'text', export: false, sortable: false, value: () => null, render: rowAction});
  return columns;
}

export function ReleaseWindowGrid({request: requestProp, families = null, title = '全作品のウィンドウ', showTitle = true, description, persistKey = 'release-windows', rowAction, revision: outerRevision = 0, onLoaded}) {
  const shell = useShell();
  const requestRef = useRef(null);
  requestRef.current = requestProp || shell.request;
  const request = useCallback((path, options) => requestRef.current(path, options), []);
  const readOnly = Boolean(shell.readOnly);
  const [params, setParam] = useWindowParams(shell);
  const query = windowQuery(params, {families});
  const [state, setState] = useState({loading: true});
  const [revision, setRevision] = useState(0);
  const [selected, setSelected] = useState({});
  const [expand, setExpand] = useState(undefined);
  const [qText, setQText] = useState(params.q);
  useEffect(() => { setQText(params.q); }, [params.q]);

  useEffect(() => {
    let live = true;
    setState((previous) => ({...previous, loading: true, error: null}));
    request(`/release-windows${query ? `?${query}` : ''}`)
      .then((body) => { if (live) { setState({body}); onLoaded?.(body); } })
      .catch((error) => { if (live) setState({error}); });
    return () => { live = false; };
  }, [request, query, revision, outerRevision]); // eslint-disable-line react-hooks/exhaustive-deps

  const body = state.body;
  const allTypes = body?.types || [];
  const shownTypes = allTypes.filter((type) => (body?.selectedTypeKeys || []).includes(type.type_key));
  const familyTypes = allTypes.filter((type) => !families?.length ? !params.fam || type.family === params.fam : families.includes(type.family));
  const open = useCallback((row, type) => {
    setSelected((previous) => ({...previous, [row.work_id]: type.type_key}));
    setExpand({key: String(row.work_id), nonce: `${row.work_id}:${type.type_key}:${Date.now()}`});
  }, []);
  const columns = useMemo(() => windowColumns(shownTypes, {view: params.view, onOpen: open, rowAction}), [shownTypes, params.view, open, rowAction]);
  const exportHref = `/api/release-windows/export.xlsx${query ? `?${query}` : ''}`;
  const filtersActive = Boolean(params.type || params.state || params.date || params.from || params.to || params.q || params.warn || (!families && params.fam));
  const clear = () => { for (const key of ['fam', 'type', 'state', 'date', 'from', 'to', 'q', 'warn', 'page']) shell.setParam(`${P}${key}`, null, {replace: true}); };
  const page = body?.page || 1, pages = body?.pages || 1, pageSize = body?.pageSize || PAGE_SIZE;
  const from = body?.total ? (page - 1) * pageSize + 1 : 0, to = Math.min(page * pageSize, body?.total || 0);

  return (
    <section className="card rp-report rw-grid" aria-label={title}>
      <header className="so-head">
        <div>
          {showTitle && <h2>{title}</h2>}
          <p className="rp-muted">{description || '1行1作品。ウィンドウが無い作品も「未登録」で出します。日付のセルを押すと、版の履歴と新しい版の入力が出ます。警告はその場で計算した確認事項で、登録は止めません。'}</p>
        </div>
        <div className="so-actions">
          <div className="rw-view" role="group" aria-label="見せ方">
            {[['dates', '日付だけ'], ['all', '全項目']].map(([value, label]) => (
              <button key={value} type="button" className={params.view === value ? '' : 'secondary'} aria-pressed={params.view === value} onClick={() => setParam('view', value === 'dates' ? null : value)}>{label}</button>
            ))}
          </div>
          <a className="bc-link-button rw-link-button" href={exportHref} download>Excelで出力（条件に合う全行）</a>
        </div>
      </header>
      <div className="rw-filters" role="search" aria-label="ウィンドウの絞り込み">
        {!families?.length && (
          <FormField type="select" label="分類" value={params.fam} blankLabel="すべて" onChange={(value) => { setParam('fam', value); setParam('type', null); }}
            options={Object.entries(WINDOW_FAMILIES).filter(([key]) => allTypes.some((type) => type.family === key)).map(([value, label]) => ({value, label}))} />
        )}
        <FormField type="select" label="種別" value={params.type} blankLabel="すべて" onChange={(value) => setParam('type', value)}
          options={familyTypes.map((type) => ({value: type.type_key, label: type.label}))} />
        <FormField type="select" label="状態" value={params.state} blankLabel="すべて" onChange={(value) => setParam('state', value)}
          options={Object.entries(WINDOW_STATES).map(([value, label]) => ({value, label}))} />
        <FormField type="select" label="期間の基準" value={params.date} blankLabel="指定しない" onChange={(value) => setParam('date', value)}
          options={Object.entries(DATE_FIELDS).map(([value, label]) => ({value, label}))} />
        <FormField type="month" label="期間（から）" value={params.from} disabled={!params.date} onChange={(value) => setParam('from', /^\d{4}-\d{2}$/.test(value) ? value : null)} />
        <FormField type="month" label="期間（まで）" value={params.to} disabled={!params.date} onChange={(value) => setParam('to', /^\d{4}-\d{2}$/.test(value) ? value : null)} />
        <form className="rw-q" onSubmit={(event) => { event.preventDefault(); setParam('q', qText.trim()); }}>
          <FormField type="search" label="作品コード・作品名・案件" value={qText} onChange={(value) => setQText(value)} />
          <button type="submit" className="secondary">探す</button>
        </form>
        <label className="dg-check rw-warn-only"><input type="checkbox" checked={params.warn === '1'} onChange={(event) => setParam('warn', event.target.checked ? '1' : null)} />警告のあるものだけ</label>
        <button type="button" className="secondary" disabled={!filtersActive} onClick={clear}>条件を解除</button>
      </div>
      {body && (
        <p className="rp-meta" aria-live="polite">
          <span>閲覧できる作品 {int(body.worksVisible)}件</span>
          <span>条件に合う作品 {int(body.total)}件</span>
          <span>種別 {int(shownTypes.length)}種</span>
          {Object.entries(body.counts.byState).map(([key, n]) => <span key={key}>{WINDOW_STATES[key]} {int(n)}</span>)}
          {body.counts.warningWindows > 0 && <span className="rp-warn">警告のあるウィンドウ {int(body.counts.warningWindows)}件</span>}
        </p>
      )}
      {state.error && <Notice error={state.error} onRetry={() => setRevision((n) => n + 1)} />}
      {body?.needsAdoption && <Notice tone="warn" message={body.canAdmin ? 'ウィンドウの種別がまだありません。下の「ウィンドウの種別」で初期の種別を採用してください。' : 'ウィンドウの種別がまだありません。管理者に初期の種別の採用を依頼してください。'} />}
      {state.loading && !body && <p className="rp-muted" aria-busy="true">読み込み中…</p>}
      {body && !body.needsAdoption && (
        <DataGrid key={`${params.view}:${shownTypes.map((type) => type.type_key).join(',')}`} columns={columns} rows={body.rows} rowKey="work_id" persistKey={`${persistKey}:${params.view}`}
          ariaLabel={title} showTotals={false} expandRequest={expand} maxHeight="70vh"
          emptyText={body.worksVisible ? '条件に合う作品がありません。条件を解除してください。' : '閲覧できる作品がありません。'}
          renderDetail={(row) => (
            <WindowDetail request={request} row={row} types={shownTypes} selectedKey={selected[row.work_id] || null} readOnly={readOnly}
              onSelect={(key) => setSelected((previous) => ({...previous, [row.work_id]: key}))} onSaved={() => setRevision((n) => n + 1)} />
          )} />
      )}
      {body && body.total > 0 && (
        <nav className="rw-pager" aria-label="ページ送り">
          <button type="button" className="secondary" disabled={page <= 1} onClick={() => setParam('page', page - 1 > 1 ? String(page - 1) : null)}>前の{pageSize}件</button>
          <span>{int(from)}〜{int(to)}件目（全{int(body.total)}件・{page}/{pages}ページ）</span>
          <button type="button" className="secondary" disabled={page >= pages} onClick={() => setParam('page', String(page + 1))}>次の{pageSize}件</button>
        </nav>
      )}
    </section>
  );
}

export default ReleaseWindowGrid;
