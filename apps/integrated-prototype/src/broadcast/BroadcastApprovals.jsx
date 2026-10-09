// 放送枠の承認待ち（作品横断）。作品を切り替えずに一覧し、その場で承認・差し戻しする。
// 差し戻し・中止の理由は画面内で入力する（確認ダイアログを使わない）。中止は元に戻せないので画面内で2段にする。
// 使い方: <BroadcastApprovals onOpenWork={(workId) => ...} onChanged={() => ...} />（request は props か外枠の文脈）
import React, {useCallback, useEffect, useMemo, useState} from 'react';
import {useShell} from '../shell/context.mjs';
import {DataGrid} from '../ui/DataGrid.jsx';
import {Notice} from '../ui/Notice.jsx';
import {Tabs} from '../ui/Tabs.jsx';
import {labelOf} from '../ui/labels.mjs';
import {dateJst, dateTimeJst} from '../ui/format.mjs';
import {slotActions, approvalSummary, waitingDays, conflictText, transitionMessage, reasonError} from './broadcast-model.mjs';
import '../reports/reports.css';
import '../broadcast-ui.css';

// 1つの放送枠の状態遷移ボタン。理由が要る操作は、押すと理由の入力欄と確定ボタンを出す。
// row: {slotId, revision, status, workTitle, broadcastMonth, stationName}
// onDone({tone:'ok', message, revision} | {error})
export function SlotActionBar({row, actions, request, onDone, initialKind = null, compact = false}) {
  const [open, setOpen] = useState(() => actions.find((action) => action.kind === initialKind && action.needsReason) || null);
  const [reason, setReason] = useState('');
  const [fieldError, setFieldError] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!initialKind) return;
    const next = actions.find((action) => action.kind === initialKind && action.needsReason);
    if (next) setOpen(next);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialKind, row.slotId]);
  if (!actions.length) return null;

  async function run(action, text) {
    setBusy(true);
    try {
      const body = {baseRevision: row.revision, status: action.to};
      if (action.needsReason) body.reason = text;
      const result = await request(`/broadcast/slots/${row.slotId}/transition`, {method: 'POST', body: JSON.stringify(body)});
      setOpen(null);
      setReason('');
      onDone?.({tone: 'ok', message: transitionMessage(row, action.to, result?.revision), revision: result?.revision});
    } catch (error) {
      onDone?.({error});
    } finally {
      setBusy(false);
    }
  }

  function choose(action) {
    if (!action.needsReason) { run(action); return; }
    setFieldError('');
    setOpen((current) => (current?.to === action.to ? null : action));
  }

  function confirmReason(event) {
    event.preventDefault();
    const problem = reasonError(reason, {kind: open.kind});
    if (problem) { setFieldError(problem); return; }
    run(open, reason.trim());
  }

  const reasonId = `bc-reason-${row.slotId}-${open?.to || ''}`;
  return (
    <div className={`bc-actions${compact ? ' is-compact' : ''}`}>
      <div className="bc-action-buttons">
        {actions.map((action) => (
          <button key={action.to} type="button" disabled={busy}
            className={action.kind === 'approve' || action.kind === 'submit' ? '' : 'secondary'}
            aria-expanded={action.needsReason ? open?.to === action.to : undefined}
            onClick={() => choose(action)}>
            {action.needsReason ? `${action.label}…` : action.label}
          </button>
        ))}
      </div>
      {open && (
        <form className={`bc-reason${open.irreversible ? ' is-irreversible' : ''}`} onSubmit={confirmReason}>
          {open.irreversible && <p className="bc-reason-warn" role="note">中止すると元に戻せません（この放送枠は再申請できなくなります）。理由を入れて確定してください。</p>}
          <label htmlFor={reasonId}>{open.kind === 'cancel' ? '中止の理由' : '差し戻す理由（申請した人に表示されます）'}<span className="on-req">必須</span></label>
          <textarea id={reasonId} rows={2} value={reason} autoFocus maxLength={1000}
            aria-invalid={fieldError ? true : undefined} aria-describedby={fieldError ? `${reasonId}-error` : undefined}
            onChange={(event) => { setReason(event.target.value); setFieldError(''); }} />
          {fieldError && <p id={`${reasonId}-error`} className="on-field-error">{fieldError}</p>}
          <div className="bc-action-buttons">
            <button type="submit" disabled={busy} className={open.irreversible ? 'bc-danger' : ''}>{open.kind === 'cancel' ? '中止を確定する' : '差し戻す'}</button>
            <button type="button" className="secondary" disabled={busy} onClick={() => { setOpen(null); setFieldError(''); }}>戻る</button>
          </div>
        </form>
      )}
    </div>
  );
}

function StationCell({row}) {
  return (
    <span className="bc-station">
      <span>{row.stationName}</span>
      {!row.stationRegistered && <span className="bc-badge is-warn">未登録の局</span>}
    </span>
  );
}

function ConflictCell({row}) {
  if (!row.conflict) return <span className="bc-muted">{conflictText(null)}</span>;
  return <span className={`bc-flag ${row.conflict === 'red' ? 'is-bad' : 'is-warn'}`}>{conflictText(row.conflict)}</span>;
}

function ApprovalDetail({row, request, isAdmin, initialKind, onDone, onOpenWork, readOnly}) {
  const actions = readOnly ? [] : slotActions(row, {canEdit: row.canEdit, isAdmin});
  return (
    <div className="rp-drill">
      <dl className="sl-detail">
        {[
          ['作品', `${row.workTitle}（${row.workCode}）`],
          ['放送局', row.stationRegistered ? `${row.stationName}（取引先に登録済み）` : `${row.stationName}（未登録の局）`],
          ['段階', `${labelOf('broadcastStatus', row.status)}・第${row.revision}版`],
          ['申請', `${dateTimeJst(row.requestedAt)}${row.requestedBy ? `・${row.requestedBy}` : ''}`],
          ['期間', `${dateJst(row.periodFrom)}〜${dateJst(row.periodTo)}`],
          ['放送予定日・回数', `${row.plannedOn ? dateJst(row.plannedOn) : '未定'}・${row.plannedRuns}回`],
          ['取引先', row.customerName || '未紐付け'],
          ['代理店', row.agencyName || '代理店なし'],
          ['販売契約', row.agreementTitle ? `${row.agreementCode}・${row.agreementTitle}` : '未紐付け'],
          ['根拠', row.sourceReference || '未登録'],
          ...(row.reason ? [['前回の理由', row.reason]] : []),
        ].map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}
      </dl>
      {row.conflictWith?.length > 0 && (
        <Notice tone={row.conflict === 'red' ? 'error' : 'warn'} compact
          message={`同じ月に別の局の放送枠があります: ${row.conflictWith.map((other) => `${other.stationName}（${labelOf('broadcastStatus', other.status)}）`).join('、')}`} />
      )}
      {!isAdmin && row.status.startsWith('pending') && <p className="rp-muted">承認・差し戻しは管理者が行います。</p>}
      <SlotActionBar row={row} actions={actions} request={request} onDone={onDone} initialKind={initialKind} />
      {onOpenWork && <div><button type="button" className="secondary" onClick={() => onOpenWork(row.workId)}>この作品の放送枠を開く</button></div>}
    </div>
  );
}

export default function BroadcastApprovals({request: requestProp, onOpenWork, onChanged}) {
  const shell = useShell();
  const request = requestProp || shell.request;
  const readOnly = Boolean(shell.readOnly);
  const [scope, setScope] = useState(() => (shell.getParam('approvalScope', 'pending') === 'open' ? 'open' : 'pending'));
  const [state, setState] = useState({loading: true});
  const [notice, setNotice] = useState(null);
  const [expand, setExpand] = useState(null);
  const [openKind, setOpenKind] = useState({});

  const load = useCallback(async () => {
    try {
      const body = await request(`/broadcast/approvals?scope=${scope}`);
      setState({body});
    } catch (error) {
      setState((previous) => ({body: previous.body, error}));
    }
  }, [request, scope]);
  useEffect(() => { load(); }, [load]);

  const rows = useMemo(() => state.body?.rows || [], [state.body]);
  const isAdmin = Boolean(state.body?.approvalRole);
  const summary = useMemo(() => approvalSummary(rows), [rows]);

  const done = useCallback(async (result) => {
    if (result.error) setNotice({error: result.error, onRetry: load});
    else setNotice({tone: 'ok', message: result.message});
    await load();
    if (!result.error) onChanged?.();
  }, [load, onChanged]);

  const openDetail = (row, kind) => {
    setOpenKind((current) => ({...current, [row.slotId]: kind}));
    setExpand({key: String(row.slotId), nonce: Date.now()});
  };

  const columns = useMemo(() => [
    {key: 'workTitle', label: '作品', type: 'text', sticky: true, render: (row) => <span className="bc-work"><strong>{row.workTitle}</strong><small>{row.workCode}</small></span>},
    {key: 'broadcastMonth', label: '放送月', type: 'month'},
    {key: 'stationName', label: '放送局', type: 'text', render: (row) => <StationCell row={row} />},
    {key: 'status', label: '段階', type: 'status', domain: 'broadcastStatus'},
    {key: 'waiting', label: '申請からの日数', type: 'int', total: 'none', value: (row) => waitingDays(row.requestedAt)},
    {key: 'period', label: '期間', type: 'text', value: (row) => `${dateJst(row.periodFrom)}〜${dateJst(row.periodTo)}`},
    {key: 'customerName', label: '取引先', type: 'text', value: (row) => row.customerName || '未紐付け'},
    {key: 'conflict', label: '競合', type: 'text', value: (row) => conflictText(row.conflict), render: (row) => <ConflictCell row={row} />},
    {
      key: 'actions', label: '操作', type: 'text', export: false, value: () => null,
      render: (row) => {
        if (readOnly) return <span className="bc-muted">閲覧のみ</span>;
        const approve = slotActions(row, {canEdit: row.canEdit, isAdmin, include: ['approve', 'submit']});
        const reject = slotActions(row, {canEdit: row.canEdit, isAdmin, include: ['reject']});
        if (!approve.length && !reject.length) return <span className="bc-muted">{row.status.startsWith('pending') ? '管理者の承認待ち' : '詳細から操作'}</span>;
        return (
          <span className="bc-action-buttons">
            <SlotActionBar row={row} actions={approve} request={request} onDone={done} compact />
            {reject.length > 0 && <button type="button" className="secondary" onClick={() => openDetail(row, 'reject')}>差し戻す…</button>}
          </span>
        );
      },
    },
  ], [isAdmin, readOnly, request, done]);

  const scopeTabs = [
    {id: 'pending', label: '承認待ち', badge: scope === 'pending' ? rows.length : undefined},
    {id: 'open', label: '申請前・差し戻しも含める'},
  ];

  return (
    <section className="card rp-report bc-approvals" aria-label="放送枠の承認待ち（全作品）">
      <header className="rp-head">
        <div>
          <h3>放送枠の承認待ち（全作品）</h3>
          <p className="rp-muted">閲覧できるすべての作品の放送枠を、作品を切り替えずに確かめて承認・差し戻しします。行を押すと詳細と理由の入力欄が開きます。</p>
        </div>
        <button type="button" className="secondary" onClick={load}>再読込</button>
      </header>
      <Tabs tabs={scopeTabs} value={scope} urlKey="approvalScope" label="表示する放送枠" onChange={(next) => { setScope(next); setNotice(null); }} />
      {notice && <Notice tone={notice.tone} message={notice.message} error={notice.error} onRetry={notice.onRetry} retryLabel="再読込" onDismiss={() => setNotice(null)} />}
      {state.error && <Notice error={state.error} onRetry={load} />}
      {state.loading && !state.body && <p className="rp-muted">読み込み中…</p>}
      {state.body && (
        <>
          <div className="rp-tiles">
            <div><span>一次承認待ち</span><strong>{summary.first}件</strong></div>
            <div><span>最終承認待ち</span><strong>{summary.final}件</strong></div>
            <div><span>最も長い待ち</span><strong>{summary.oldestDays === null ? '—' : `${summary.oldestDays}日`}</strong></div>
            <div><span>同じ月に別の局がある</span><strong className={summary.conflicts ? 'rp-warn' : ''}>{summary.conflicts}件</strong></div>
          </div>
          {!isAdmin && <Notice tone="info" compact message="承認・差し戻しは管理者が行います。ここでは申請の状況と差し戻しの理由を確かめられます。" />}
          <DataGrid columns={columns} rows={rows} rowKey="slotId" persistKey="broadcast-approvals" ariaLabel="放送枠の承認待ち"
            emptyText={scope === 'pending' ? '承認待ちの放送枠はありません' : '対応が必要な放送枠はありません'}
            expandRequest={expand} initialSort={{key: 'waiting', dir: 'desc'}} blankZero={false}
            exportSpec={{name: '放送枠の承認待ち', title: '放送枠の承認待ち（全作品）', conditions: [['表示', scope === 'pending' ? '承認待ち' : '申請前・差し戻しも含める']]}}
            renderDetail={(row) => (
              <ApprovalDetail row={row} request={request} isAdmin={isAdmin} readOnly={readOnly} initialKind={openKind[row.slotId] || null}
                onDone={done} onOpenWork={onOpenWork} />
            )} />
          <p className="rp-muted">申請からの日数は、いまの段階になった日（日本時間）から数えます。</p>
        </>
      )}
    </section>
  );
}
