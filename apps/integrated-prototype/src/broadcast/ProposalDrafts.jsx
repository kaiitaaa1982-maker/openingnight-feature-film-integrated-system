// 放送ウィンドウ提案から放送枠の下書きを作る（DraftComposer）と、提案から作った下書きの一覧（ProposalDraftsPanel）。
// 設計: docs/platform/team-development/broadcast-windows.md §9。
// - 下書きは放送枠（作品×月×局・状態「下書き」）。合意したら「放送枠を開く」から放送枠のタブで申請し、承認の流れ（申請→承認→確定）へ進める
// - 合意に至らなければ、下書きのうちだけ「削除（合意に至らず）」で理由を書いて削除する（放送枠の一覧・放送履歴表・二重登録の判定から外れ、
//   同じ作品・月・局はあとでもう一度提案できる）。削除は元に戻せないので、画面の中で理由の入力と確定の2段にする（確認ダイアログは使わない）
import React, {useEffect, useId, useMemo, useRef, useState} from 'react';
import {DataGrid} from '../ui/DataGrid.jsx';
import {Notice} from '../ui/Notice.jsx';
import {labelOf} from '../ui/labels.mjs';
import {dateTimeJst} from '../ui/format.mjs';
import {STATION_TYPES} from './window-proposal-model.mjs';
import {intervalText, dateSlash, ymText} from './intervals.mjs';
import {proposalMonthOptions, monthOptionLabel, groupBlockedMonths, duplicateMonths, runKindOf, draftCountsText, DRAFT_RUN_KINDS, DELETED_LABEL} from './proposal-draft-model.mjs';

const stationText = (station) => `${station.name}（${STATION_TYPES[station.station_type] || '種別未登録'}）`;

// 提案の行から下書きを作る入力。row は放送ウィンドウ提案の1行（result・live_slots・can_edit を持つ）
export function DraftComposer({row, asOf, minMonths, stations = [], request, onCreated, onClose}) {
  const formId = useId();
  const options = useMemo(() => proposalMonthOptions(row.result), [row.result]);
  const blockedGroups = useMemo(() => groupBlockedMonths(options.blocked), [options]);
  const [stationId, setStationId] = useState('');
  const station = stations.find((s) => String(s.partner_id) === stationId) || null;
  const duplicates = useMemo(() => duplicateMonths(row.live_slots, station?.name), [row.live_slots, station]);
  const [months, setMonths] = useState([]);
  const chosen = options.months.filter((o) => months.includes(o.month) && !duplicates.has(o.month));
  const suggestedRun = runKindOf((chosen[0] || options.months[0])?.run);
  const [runKind, setRunKind] = useState(null); // null は提案の初回／再放送に合わせる
  const run = runKind || suggestedRun;
  const [memo, setMemo] = useState('');
  const [errors, setErrors] = useState({});
  const [failure, setFailure] = useState(null);
  const [busy, setBusy] = useState(false);
  const toggle = (month, on) => { setMonths((current) => (on ? [...new Set([...current, month])] : current.filter((m) => m !== month))); setErrors((e) => ({...e, months: undefined})); };

  async function submit(event) {
    event.preventDefault();
    const problems = {};
    if (!station) problems.station = '放送局を選んでください';
    if (!chosen.length) problems.months = '放送する月を1つ以上選んでください（提案する期間の中の月だけ選べます）';
    setErrors(problems);
    if (Object.keys(problems).length) return;
    setBusy(true);
    setFailure(null);
    try {
      const result = await request('/broadcast/window-proposals/drafts', {method: 'POST', body: JSON.stringify({
        workId: row.work_id, productId: row.product_id, asOf, minMonths: Number(minMonths), stationPartnerId: station.partner_id,
        months: chosen.map((o) => o.month), runKind: run, memo: memo.trim() || null,
      })});
      onCreated?.({...result, station, months: chosen.map((o) => o.month), row});
    } catch (error) {
      setFailure({error});
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="bw-compose" aria-label={`${row.product_name}の提案から放送枠の下書きを作る`} onSubmit={submit} noValidate>
      <h5>提案する（放送枠の下書きを作る）</h5>
      <p className="rp-muted">局と放送する月を選ぶと、月ごとに放送枠（作品×月×局）の下書きを作ります。合意したら「提案から作った下書き」の「放送枠を開く」から申請し、合意に至らなければそこで削除します。</p>
      <label className="bw-field" htmlFor={`${formId}-station`}><span>放送局（取引先。種別つき）<span className="on-req">必須</span></span>
        <select id={`${formId}-station`} value={stationId} aria-invalid={errors.station ? true : undefined}
          onChange={(event) => { setStationId(event.target.value); setErrors((e) => ({...e, station: undefined})); }}>
          <option value="">局を選ぶ</option>
          {stations.map((s) => <option key={s.partner_id} value={String(s.partner_id)}>{stationText(s)}</option>)}
        </select>
      </label>
      {errors.station && <p className="on-field-error">{errors.station}</p>}
      {!stations.length && <Notice tone="info" compact message="区分に「放送局」がある取引先がありません。取引先の区分に「放送局」を付けるか、下の「放送局の種別」で局を登録してください。" />}
      <fieldset aria-invalid={errors.months ? true : undefined}>
        <legend>放送する月（提案する期間の中の月。複数選べます）</legend>
        {options.months.length ? (
          <div className="bw-months">
            {options.months.map((o) => {
              const dup = duplicates.get(o.month);
              return (
                <label key={o.month} className="bc-check">
                  <input type="checkbox" checked={months.includes(o.month) && !dup} disabled={Boolean(dup)} onChange={(event) => toggle(o.month, event.target.checked)} />
                  {monthOptionLabel(o)}{o.run === '再放送' ? '・再放送' : ''}
                  {dup && <small>（この局の放送枠あり・{labelOf('broadcastStatus', dup.status)}・放送枠ID {dup.slot_id}）</small>}
                </label>
              );
            })}
          </div>
        ) : <p className="rp-muted">提案する期間の中に選べる月がありません。</p>}
        {errors.months && <p className="on-field-error">{errors.months}</p>}
        {blockedGroups.length > 0 && (
          <details>
            <summary>選べない月（{options.blocked.length}か月）と理由</summary>
            <ul className="bw-blocked">{blockedGroups.map((g) => <li key={g.from}>{g.text}</li>)}</ul>
          </details>
        )}
      </fieldset>
      <fieldset>
        <legend>初回／再放送</legend>
        <div className="bw-months">
          {Object.entries(DRAFT_RUN_KINDS).map(([key, label]) => (
            <label key={key} className="bc-check"><input type="radio" name={`${formId}-run`} value={key} checked={run === key} onChange={() => setRunKind(key)} />{label}</label>
          ))}
        </div>
        <p className="rp-muted">提案の計算では{DRAFT_RUN_KINDS[suggestedRun]}です（その月より前に確定の枠か実放送があれば再放送）。</p>
      </fieldset>
      <label className="bw-field" htmlFor={`${formId}-memo`}>メモ（局の担当・条件など。任意）
        <textarea id={`${formId}-memo`} rows={2} maxLength={1000} value={memo} onChange={(event) => setMemo(event.target.value)} />
      </label>
      {failure && <Notice tone={failure.tone} message={failure.message} error={failure.error} />}
      <div className="on-form-actions">
        <button type="submit" disabled={busy}>{busy ? '作っています…' : `下書きを作る（${chosen.length}か月）`}</button>
        <button type="button" className="secondary" disabled={busy} onClick={onClose}>閉じる</button>
      </div>
    </form>
  );
}

// 下書きのうちの削除。押すと理由の入力欄と確定のボタンを出す（元に戻せないので2段）
export function DraftDeleteBar({row, request, onDone}) {
  const id = useId();
  const formRef = useRef(null);
  const [open, setOpen] = useState(false);
  // 確認の欄は表の「操作」のセル（右端の列）の中に出る。開いたら表を横に送って欄の全体を見せる
  useEffect(() => { if (open) formRef.current?.scrollIntoView?.({block: 'nearest', inline: 'nearest'}); }, [open]);
  const [reason, setReason] = useState('');
  const [fieldError, setFieldError] = useState('');
  const [busy, setBusy] = useState(false);
  async function submit(event) {
    event.preventDefault();
    if (!reason.trim()) { setFieldError('削除の理由（合意に至らなかった理由）を入れてください'); return; }
    setBusy(true);
    try {
      await request(`/broadcast/window-proposals/drafts/${row.slot_id}/delete`, {method: 'POST', body: JSON.stringify({baseRevision: row.revision, reason: reason.trim()})});
      setOpen(false);
      setReason('');
      onDone?.({tone: 'ok', message: `${row.work_title}・${ymText(row.broadcast_month)}・${row.station_name}の下書きを削除しました（合意に至らず）。同じ作品・月・局は、あとでもう一度提案できます`});
    } catch (error) {
      onDone?.({error});
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="bc-actions is-compact">
      <button type="button" className="secondary" aria-expanded={open} disabled={busy} onClick={() => { setOpen((v) => !v); setFieldError(''); }}>削除（合意に至らず）…</button>
      {open && (
        <form className="bc-reason is-irreversible" ref={formRef} onSubmit={submit}>
          <p className="bc-reason-warn" role="note">削除すると元に戻せません。この下書きは放送枠の一覧・放送履歴表から外れます（誰が・いつ・なぜ削除したかは記録に残ります）。</p>
          <label htmlFor={`${id}-reason`}>削除の理由（合意に至らなかった理由）<span className="on-req">必須</span></label>
          <textarea id={`${id}-reason`} rows={2} maxLength={1000} value={reason} autoFocus aria-invalid={fieldError ? true : undefined}
            aria-describedby={fieldError ? `${id}-error` : undefined} onChange={(event) => { setReason(event.target.value); setFieldError(''); }} />
          {fieldError && <p id={`${id}-error`} className="on-field-error">{fieldError}</p>}
          <div className="bc-action-buttons">
            <button type="submit" className="bc-danger" disabled={busy}>{busy ? '削除しています…' : '削除する'}</button>
            <button type="button" className="secondary" disabled={busy} onClick={() => { setOpen(false); setFieldError(''); }}>戻る</button>
          </div>
        </form>
      )}
    </div>
  );
}

const workCell = (row) => <span className="bc-work"><span>{row.work_title}</span><small>{row.work_code}</small></span>;
// 局・種別・月は放送枠の最新版。提案の後に放送枠のタブで月・局を直した行には印を付ける
const CHANGED_MARK = '放送枠のタブで修正済み（提案の後に月・局を変更）';
const draftStationText = (row) => `${row.station_name}（${STATION_TYPES[row.station_type] || '種別未登録'}）`;
const stationValue = (row) => `${draftStationText(row)}${row.changed_after_proposal ? `・${CHANGED_MARK}` : ''}`;
const stationCell = (row) => (
  <span className="bw-draft-cell">
    <span>{draftStationText(row)}</span>
    {row.changed_after_proposal && <span className="bc-flag">{CHANGED_MARK}</span>}
  </span>
);
// 提案する期間の外に出た行（今の月が独占・ホールドバックの月に入った、提案したときの期間の外へ移したなど）
const warnText = (row) => (row.needs_check ? `提案する期間の外（要確認）：${row.check_reason}` : row.outside_proposal ? '提案したときの期間の外へ移しました（要確認）' : '');
const proposalText = (row) => `${intervalText({from: row.proposal_from, to: row.proposal_to})}（${dateSlash(row.as_of)}）`;
const proposalCell = (row) => (
  <span className="bw-draft-cell">
    <span>{proposalText(row)}</span>
    {warnText(row) && <span className="bc-flag is-warn">{warnText(row)}</span>}
  </span>
);
const proposedText = (row) => `${row.proposed_station_name}・${ymText(row.proposed_month)}`;

// 提案から作った下書きの一覧（同じタブの下）。drafts は GET /api/broadcast/window-proposals/drafts の応答
export function ProposalDraftsPanel({drafts, error, onReload, request, readOnly, onOpenSlot, title}) {
  const [notice, setNotice] = useState(null);
  const done = async (result) => { setNotice(result.error ? {error: result.error} : {tone: 'ok', message: result.message}); await onReload?.(); };
  const columns = useMemo(() => [
    {key: 'work', label: '作品', type: 'text', sticky: true, value: (row) => `${row.work_title} ${row.work_code}`, render: workCell},
    {key: 'product', label: '商品（品番）', type: 'text', value: (row) => `${row.product_name}${row.product_sku ? `（${row.product_sku}）` : ''}`},
    {key: 'station', label: '局（種別）', type: 'text', value: stationValue, render: stationCell},
    {key: 'broadcast_month', label: '放送月', type: 'month'},
    {key: 'period', label: '期間', type: 'text', value: (row) => `${dateSlash(row.period_from)}〜${dateSlash(row.period_to)}`},
    {key: 'run_label', label: '初回／再放送', type: 'text'},
    {key: 'proposal', label: '提案する期間（基準日）', type: 'text', value: (row) => `${proposalText(row)}${warnText(row) ? `・${warnText(row)}` : ''}`, render: proposalCell},
    {key: 'created_by_name', label: '作った人', type: 'text'},
    {key: 'created_at', label: '作った日時', type: 'text', value: (row) => dateTimeJst(row.created_at)},
    {key: 'status', label: '状態', type: 'status', domain: 'broadcastStatus'},
    {key: 'actions', label: '操作', type: 'text', export: false, value: () => null, render: (row) => (
      <span className="bw-draft-actions">
        <button type="button" className="secondary" onClick={() => onOpenSlot?.(row)}>{row.status === 'draft' && row.can_edit && !readOnly ? '放送枠を開く（合意したら申請）' : '放送枠を開く'}</button>
        {row.can_delete && !readOnly && <DraftDeleteBar row={row} request={request} onDone={done} />}
        {row.has_sales && row.status === 'draft' && row.can_edit && !readOnly && (
          <span className="bc-muted bw-draft-note">売上が紐付いているため削除できません。放送枠のタブで中止してください</span>
        )}
      </span>
    )},
  ], [readOnly, request, onOpenSlot]); // eslint-disable-line react-hooks/exhaustive-deps
  const deletedColumns = useMemo(() => [
    {key: 'work', label: '作品', type: 'text', sticky: true, value: (row) => `${row.work_title} ${row.work_code}`, render: workCell},
    {key: 'product', label: '商品（品番）', type: 'text', value: (row) => `${row.product_name}${row.product_sku ? `（${row.product_sku}）` : ''}`},
    {key: 'station', label: '局（種別）', type: 'text', value: stationValue, render: stationCell},
    {key: 'broadcast_month', label: '放送月', type: 'month'},
    {key: 'state', label: '状態', type: 'text', value: () => DELETED_LABEL},
    {key: 'deleted_reason', label: '削除の理由', type: 'text', wrap: true},
    {key: 'deleted_by_name', label: '削除した人', type: 'text'},
    {key: 'deleted_at', label: '削除した日時', type: 'text', value: (row) => dateTimeJst(row.deleted_at)},
    {key: 'created_by_name', label: '作った人', type: 'text'},
  ], []);
  const counts = drafts?.counts;
  return (
    <section className="card rp-report" aria-label="提案から作った下書き">
      <header className="rp-head">
        <div>
          <h3>{title || '提案から作った下書き'}</h3>
          <p className="rp-muted">放送ウィンドウ提案から作った放送枠です。合意したら「放送枠を開く」から放送枠のタブで一次承認を申請し、承認の流れ（申請→承認→確定）へ進めます。
            合意に至らなければ、下書きのうちだけ「削除（合意に至らず）」で理由を書いて削除できます。申請中・確定の枠と、放送報告の売上を紐付けた下書きはここでは削除できません（放送枠のタブの差し戻し・中止で扱います）。
            局・放送月・期間は放送枠の今の内容で、放送枠のタブで直した行には印が付きます。</p>
        </div>
        <button type="button" className="secondary" onClick={onReload}>再読込</button>
      </header>
      {notice && <Notice tone={notice.tone} message={notice.message} error={notice.error} onDismiss={() => setNotice(null)} />}
      {error && <Notice error={error} onRetry={onReload} />}
      {counts && <p className="rp-muted" role="status">{draftCountsText(counts)}</p>}
      {drafts && (
        <DataGrid columns={columns} rows={drafts.rows} rowKey="slot_id" persistKey="broadcast-proposal-drafts" ariaLabel="提案から作った下書きの一覧" showTotals={false}
          emptyText="提案から作った下書きはまだありません（上の表の「提案する（下書きを作る）」から作ります）" initialSort={{key: 'broadcast_month', dir: 'asc'}}
          exportSpec={{name: '提案から作った下書き', title: '放送ウィンドウ提案から作った放送枠の下書き'}}
          renderDetail={(row) => (
            <div className="rp-drill">
              {row.memo && <p className="bw-draft-memo"><strong>メモ：</strong>{row.memo}</p>}
              <p className="rp-muted">放送枠ID {row.slot_id}・第{row.revision}版・{labelOf('broadcastStatus', row.status)}{row.has_sales ? '・放送報告の売上あり' : ''}</p>
              {row.changed_after_proposal && <p className="bw-draft-memo"><strong>提案したときの局・月：</strong>{proposedText(row)}（{CHANGED_MARK}）</p>}
              {warnText(row) && <p className="bw-draft-memo bw-draft-warn">{warnText(row)}</p>}
              <h5>提案の根拠（作ったときの計算）</h5>
              <p className="bw-draft-memo">{row.basis_text}</p>
            </div>
          )} />
      )}
      {drafts?.deleted?.length > 0 && (
        <details className="bw-avails">
          <summary>削除した下書き（{drafts.deleted.length}件・合意に至らず）</summary>
          <DataGrid columns={deletedColumns} rows={drafts.deleted} rowKey="slot_id" persistKey="broadcast-proposal-drafts-deleted" ariaLabel="削除した下書き" showTotals={false}
            initialSort={{key: 'broadcast_month', dir: 'asc'}} />
        </details>
      )}
    </section>
  );
}

export default ProposalDraftsPanel;
