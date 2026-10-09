// 番販・放送。放送履歴表（全作品×年月・放送アベイルズリストの作成）／番販作品一覧（全作品のウィンドウを放送・配信で絞った表）／
// 販売条件の一覧・放送枠・売上突合（選んでいる作品）／承認待ち（全作品）／放送ウィンドウ提案（商品別・読み取りだけ）のタブ。
// - 可逆な保存に確認ダイアログを使わない。保存したら「前 → 後」の差分を画面に出す。
// - 放送局は取引先（区分「放送局」）から候補検索で選ぶ。一覧にない局名は明示して入力し、「未登録の局」と表示する。
// - 放送枠の入力は dialog 要素（フォーカスを閉じ込め、Esc で閉じる）。
// - Excel は日本語の見出しで出力し、取込は全行の理由と失敗行の Excel を返す（BroadcastExcel.jsx）。
// - 販売条件の登録・新しい版の正面入口は「流通別の販売条件」の画面。このタブは最新版の一覧と履歴、そこへの入口を持つ。
import React, {useCallback, useEffect, useId, useMemo, useRef, useState} from 'react';
import {useShell} from './shell/context.mjs';
import {Tabs} from './ui/Tabs.jsx';
import {DataGrid} from './ui/DataGrid.jsx';
import {Notice} from './ui/Notice.jsx';
import {FormField} from './ui/FormField.jsx';
import {EntityPicker} from './ui/EntityPicker.jsx';
import {labelOf} from './ui/labels.mjs';
import {yen, month as monthText, dateJst, dateTimeJst} from './ui/format.mjs';
import {blankSlotForm, slotFormFromRow, slotPayload, slotFormErrors, slotChangeDetails, changeNoticeDetails} from './broadcast-draft.mjs';
import {stationStatus, stationPartners, partnerItems, distributionGroups, distributionText, conflictText, slotActions, isPendingApproval} from './broadcast/broadcast-model.mjs';
import {distributionLabel} from './broadcast/broadcast-sheet.mjs';
import {BroadcastExcelRoundTrip} from './broadcast/BroadcastExcel.jsx';
import BroadcastApprovals, {SlotActionBar} from './broadcast/BroadcastApprovals.jsx';
import {ReleaseWindowGrid} from './sales-ops/ReleaseWindowGrid.jsx';
import {BroadcastHistory} from './broadcast/BroadcastHistory.jsx';
import {WindowProposals} from './broadcast/WindowProposals.jsx';
import {month as ymLabel} from './ui/format.mjs';
import './reports/reports.css';
import './broadcast-ui.css';

const RECONCILE_TEXT = {missing: '売上未紐付け', cancelled_linked: '中止枠に売上あり・要確認', linked: '売上紐付け済み', pending: '確認待ち'};
const RECONCILE_TONE = {missing: 'is-warn', cancelled_linked: 'is-bad', linked: 'is-ok', pending: ''};

// ---- 放送枠の入力（dialog） --------------------------------------------------------------------
function SlotDialog({initial, original, partners, agreements, request, onClose, onSaved}) {
  const shell = useShell();
  const ref = useRef(null);
  const titleId = useId();
  const [form, setForm] = useState(initial);
  const [errors, setErrors] = useState({});
  const [failure, setFailure] = useState(null);
  const [busy, setBusy] = useState(false);
  const stations = useMemo(() => stationPartners(partners), [partners]);
  const stationItems = useMemo(() => partnerItems(stations), [stations]);
  const customerItems = useMemo(() => partnerItems(partners, {preferRole: 'customer'}), [partners]);
  const agencyItems = useMemo(() => partnerItems(partners, {preferRole: 'agency'}), [partners]);
  const initialStation = useMemo(() => stationStatus(initial.stationName, partners), [initial, partners]);
  const [freeStation, setFreeStation] = useState(() => !stations.length || Boolean(String(initial.stationName || '').trim()) && !initialStation.registered);
  const [stationId, setStationId] = useState(initialStation.partner?.id ?? null);
  const dirty = JSON.stringify(slotPayload(form)) !== JSON.stringify(slotPayload(initial));
  const set = (key, value) => { setForm((current) => ({...current, [key]: value})); setErrors((current) => ({...current, [key]: undefined})); };

  useEffect(() => {
    const dialog = ref.current;
    const previous = typeof document !== 'undefined' ? document.activeElement : null;
    if (dialog && typeof dialog.showModal === 'function' && !dialog.open) dialog.showModal();
    else if (dialog) dialog.setAttribute('open', '');
    // showModal は最初のボタン（閉じる）に移るので、最初の入力欄へ移す
    dialog?.querySelector('.on-form-grid input, .on-form-grid select, .on-form-grid textarea')?.focus();
    return () => {
      if (dialog?.open && typeof dialog.close === 'function') dialog.close();
      previous?.focus?.();
    };
  }, []);
  useEffect(() => {
    shell.registerUnsaved('broadcast-slot-form', dirty ? 1 : 0, '放送枠の入力');
    return () => shell.registerUnsaved('broadcast-slot-form', 0);
  }, [dirty]); // eslint-disable-line react-hooks/exhaustive-deps

  const changes = original ? slotChangeDetails(form, original, {partners, agreements}) : [];
  const nextRevision = original ? Number(original.revision) + 1 : 1;
  const workAgreements = agreements.map((agreement) => ({value: String(agreement.id), label: `${agreement.contract_code}・${agreement.title}／${agreement.partner_name}（${agreement.license_start ? dateJst(agreement.license_start) : '開始未定'}〜${agreement.license_end ? dateJst(agreement.license_end) : '終了未定'}）`}));

  async function submit(event) {
    event.preventDefault();
    const problems = slotFormErrors(form);
    setErrors(problems);
    if (Object.keys(problems).length) return;
    if (original && !changes.length) { setFailure({tone: 'warn', message: '前の版から変わった項目がありません。直す項目を入れてください'}); return; }
    setBusy(true);
    setFailure(null);
    try {
      const payload = slotPayload(form);
      const result = original
        ? await request(`/broadcast/slots/${original.slot_id}`, {method: 'PATCH', body: JSON.stringify(payload)})
        : await request('/broadcast/slots', {method: 'POST', body: JSON.stringify(payload)});
      shell.registerUnsaved('broadcast-slot-form', 0);
      onSaved({existing: Boolean(original), revision: result?.revision, changes, stationName: payload.stationName, stationRegistered: stationStatus(payload.stationName, partners).registered});
    } catch (error) {
      setFailure({error});
    } finally {
      setBusy(false);
    }
  }

  return (
    <dialog ref={ref} className="bc-dialog" aria-labelledby={titleId} onCancel={(event) => { event.preventDefault(); onClose(); }}>
      <form className="bc-dialog-body" onSubmit={submit} noValidate>
        <header className="bc-dialog-head">
          <h3 id={titleId}>{original ? `放送枠を修正（第${nextRevision}版を作る）` : '放送枠を追加（下書き）'}</h3>
          <button type="button" className="secondary" onClick={onClose}>閉じる</button>
        </header>
        <p className="rp-muted">保存すると下書きになります。申請・承認は保存の後に一覧の行から行います。Esc キーでも閉じられます（入力は保存されません）。</p>
        <div className="on-form-grid">
          <FormField type="month" label="放送月" required autoFocus value={form.broadcastMonth} onChange={(value) => set('broadcastMonth', value)} error={errors.broadcastMonth} />
          <fieldset className="bc-station-field on-field-wide">
            <legend>放送局<span className="on-req">必須</span></legend>
            {freeStation ? (
              <FormField label="局名（取引先に未登録の局）" value={form.stationName} onChange={(value) => set('stationName', value)} error={errors.stationName}
                hint="取引先に登録されていない局として保存し、一覧に「未登録の局」と表示します。取引先の区分に「放送局」を付けると候補に出ます。" />
            ) : (
              <EntityPicker label="放送局（取引先から選ぶ）" items={stationItems} value={stationId} error={errors.stationName}
                emptyText="未確定（候補から選んでください）"
                onChange={(id, meta) => {
                  setStationId(id);
                  set('stationName', id ? meta?.item?.label ?? '' : '');
                  if (id && !form.customerPartnerId) set('customerPartnerId', id);
                }} />
            )}
            {stations.length > 0 && (
              <label className="bc-check">
                <input type="checkbox" checked={freeStation} onChange={(event) => {
                  setFreeStation(event.target.checked);
                  if (!event.target.checked) { setStationId(null); set('stationName', ''); }
                }} />
                一覧にない局名を入力する
              </label>
            )}
            {!stations.length && (
              <Notice tone="info" compact message="区分に「放送局」がある取引先がまだないため、局名を入力します。"
                actions={<button type="button" className="secondary" onClick={() => shell.navigate('取引先')}>取引先を開く</button>} />
            )}
          </fieldset>
          <EntityPicker label="取引先（売上の相手）" items={customerItems} value={form.customerPartnerId === '' ? null : Number(form.customerPartnerId)} emptyText="未紐付け"
            onChange={(id) => set('customerPartnerId', id ?? '')} />
          <EntityPicker label="代理店" items={agencyItems} value={form.agencyPartnerId === '' ? null : Number(form.agencyPartnerId)} emptyText="代理店なし"
            onChange={(id) => set('agencyPartnerId', id ?? '')} />
          <FormField type="select" wide label="販売契約（この作品の放送の契約）" options={workAgreements} blankLabel="未紐付け" value={form.agreementId === '' ? '' : String(form.agreementId)} onChange={(value) => set('agreementId', value)} />
          <FormField type="date" label="期間開始" required value={form.periodFrom} onChange={(value) => set('periodFrom', value)} error={errors.periodFrom} hint="放送月の中の日付" />
          <FormField type="date" label="期間終了" required value={form.periodTo} onChange={(value) => set('periodTo', value)} error={errors.periodTo} />
          <FormField type="date" label="放送予定日" value={form.plannedOn} onChange={(value) => set('plannedOn', value)} error={errors.plannedOn} hint="未定なら空欄" />
          <FormField type="int" label="予定回数" required value={form.plannedRuns} onChange={(value) => set('plannedRuns', value)} error={errors.plannedRuns} />
          <FormField wide label="根拠（編成表・メールなど）" value={form.sourceReference} onChange={(value) => set('sourceReference', value)} error={errors.sourceReference} />
        </div>
        {original && (
          <div className="bc-changes" aria-live="polite">
            <strong>保存すると変わる項目</strong>
            {changes.length ? <ul>{changes.map((change) => <li key={change.key}>{change.label}: {change.before} → {change.after}</li>)}</ul> : <p className="rp-muted">まだありません</p>}
          </div>
        )}
        {failure && <Notice tone={failure.tone} message={failure.message} error={failure.error} />}
        <div className="on-form-actions">
          <button type="submit" disabled={busy}>{busy ? '保存しています…' : original ? `第${nextRevision}版として保存` : '下書きとして保存'}</button>
          <button type="button" className="secondary" disabled={busy} onClick={onClose}>閉じる</button>
        </div>
      </form>
    </dialog>
  );
}

// ---- 放送枠（選んでいる作品） -------------------------------------------------------------------
function SlotDetail({row, request, isAdmin, canEdit, onDone}) {
  const [history, setHistory] = useState(null);
  const [error, setError] = useState(null);
  useEffect(() => {
    request(`/broadcast/slots/${row.slot_id}/history`).then((body) => setHistory(body.rows)).catch(setError);
  }, [request, row.slot_id, row.revision]);
  const actionRow = {slotId: row.slot_id, revision: row.revision, status: row.status, workTitle: row.work_title, broadcastMonth: row.broadcast_month, stationName: row.station_name};
  return (
    <div className="rp-drill">
      {row.reason && <Notice tone={row.status === 'rejected' ? 'warn' : 'info'} compact title={row.status === 'rejected' ? '差し戻しの理由' : '理由'} message={row.reason} />}
      <SlotActionBar row={actionRow} actions={slotActions(row, {canEdit, isAdmin})} request={request} onDone={onDone} />
      {error && <Notice error={error} />}
      {history && (
        <details open={history.length <= 3}>
          <summary>版の履歴（{history.length}版）</summary>
          <ol className="bc-history">
            {history.map((version) => (
              <li key={version.revision}>
                <strong>第{version.revision}版・{labelOf('broadcastStatus', version.status)}</strong>
                <span>{version.station_name}・{dateJst(version.period_from)}〜{dateJst(version.period_to)}・{version.planned_runs}回</span>
                <small>{version.reason ? `理由: ${version.reason}` : version.source_reference ? `根拠: ${version.source_reference}` : '根拠未登録'}・{dateTimeJst(version.created_at)}</small>
              </li>
            ))}
          </ol>
        </details>
      )}
    </div>
  );
}

function SlotsPanel({work, slots: allSlots, partners, agreements, request, isAdmin, canEdit, onChanged, focusMonth, focusSlot = null, onClearFocus}) {
  // 放送履歴表のセルから来たときは、その月の枠だけを出す（「すべての月を表示」で戻す）
  const slots = useMemo(() => (focusMonth ? allSlots.filter((slot) => slot.broadcast_month === focusMonth) : allSlots), [allSlots, focusMonth]);
  // 放送ウィンドウ提案の下書きから来たときは、その枠の行を開く（理由・申請のボタン・版の履歴）
  const focused = focusSlot ? slots.find((slot) => slot.slot_id === focusSlot) || null : null;
  const expand = useMemo(() => (focused ? {key: String(focused.slot_id), nonce: focused.slot_id} : null), [focused?.slot_id]); // eslint-disable-line react-hooks/exhaustive-deps
  const [dialog, setDialog] = useState(null);
  const [notice, setNotice] = useState(null);
  const workAgreements = useMemo(() => agreements.filter((agreement) => agreement.work_id === work?.id), [agreements, work]);
  const partnerName = (id) => partners.find((partner) => partner.id === id)?.name || null;

  const done = useCallback(async (result) => {
    setNotice(result.error ? {error: result.error} : {tone: 'ok', message: result.message});
    await onChanged?.();
  }, [onChanged]);

  const columns = useMemo(() => [
    {key: 'broadcast_month', label: '放送月', type: 'month', sticky: true},
    {key: 'station_name', label: '放送局', type: 'text', render: (row) => {
      const status = stationStatus(row.station_name, partners);
      return <span className="bc-station"><span>{row.station_name}</span>{!status.registered && <span className="bc-badge is-warn">未登録の局</span>}</span>;
    }},
    {key: 'customer', label: '取引先', type: 'text', value: (row) => partnerName(row.customer_partner_id) || '未紐付け'},
    {key: 'agency', label: '代理店', type: 'text', value: (row) => partnerName(row.agency_partner_id) || '代理店なし'},
    {key: 'period', label: '期間', type: 'text', value: (row) => `${dateJst(row.period_from)}〜${dateJst(row.period_to)}`},
    {key: 'planned_on', label: '放送予定日', type: 'text', value: (row) => (row.planned_on ? dateJst(row.planned_on) : '未定')},
    {key: 'planned_runs', label: '予定回数', type: 'int'},
    {key: 'status', label: '状態', type: 'status', domain: 'broadcastStatus'},
    {key: 'conflict', label: '競合', type: 'text', value: (row) => (row.duplicate_of?.length ? `二重登録：同じ月・同じ局の枠（放送枠ID ${row.duplicate_of.join('・')}）` : conflictText(row.conflict)),
      render: (row) => (row.duplicate_of?.length ? <span className="bc-flag is-bad">二重登録：同じ月・同じ局の枠（放送枠ID {row.duplicate_of.join('・')}）</span>
        : row.conflict ? <span className={`bc-flag ${row.conflict === 'red' ? 'is-bad' : 'is-warn'}`}>{conflictText(row.conflict)}</span> : <span className="bc-muted">競合なし</span>)},
    {key: 'revision', label: '版', type: 'int', total: 'none'},
    {key: 'actions', label: '操作', type: 'text', export: false, value: () => null, render: (row) => {
      if (!canEdit) return <span className="bc-muted">閲覧のみ</span>;
      const quick = slotActions(row, {canEdit, isAdmin, include: ['submit', 'approve']});
      const actionRow = {slotId: row.slot_id, revision: row.revision, status: row.status, workTitle: work?.title, broadcastMonth: row.broadcast_month, stationName: row.station_name};
      return (
        <span className="bc-action-buttons">
          {['draft', 'rejected'].includes(row.status) && <button type="button" className="secondary" onClick={() => setDialog({original: row})}>修正</button>}
          <SlotActionBar row={actionRow} actions={quick} request={request} onDone={done} compact />
        </span>
      );
    }},
  ], [partners, canEdit, isAdmin, request, done, work]); // eslint-disable-line react-hooks/exhaustive-deps

  const months = [...new Set(slots.map((slot) => slot.broadcast_month))].sort();
  return (
    <section className="card rp-report" aria-label="放送枠">
      <header className="rp-head">
        <div>
          <h3>放送枠（{work?.title || '作品を選んでください'}）</h3>
          <p className="rp-muted">局ごとの放送枠を版で残します。下書き・差し戻しの枠だけ修正でき、行を押すと理由・申請・版の履歴が開きます。</p>
        </div>
        {canEdit && <button type="button" onClick={() => setDialog({original: null})}>放送枠を追加</button>}
      </header>
      {notice && <Notice tone={notice.tone} title={notice.title} message={notice.message} details={notice.details} error={notice.error} onDismiss={() => setNotice(null)} />}
      {focusMonth && (
        <Notice tone="info" compact message={focused
          ? `放送ウィンドウ提案から作った下書き（放送枠ID ${focused.slot_id}・${ymLabel(focusMonth)}・${focused.station_name}・${labelOf('broadcastStatus', focused.status)}）を開いています。${focused.status === 'draft' ? '局と合意したら、行の「一次承認を申請」から承認の流れ（申請→承認→確定）へ進めます。' : ''}`
          : `放送履歴表から ${ymLabel(focusMonth)} の枠だけを表示しています（${slots.length}件・全${allSlots.length}件）`}
          actions={<button type="button" className="secondary" onClick={onClearFocus}>すべての月を表示</button>} />
      )}
      <DataGrid columns={columns} rows={slots} rowKey="slot_id" persistKey="broadcast-slots" ariaLabel="放送枠の一覧" emptyText="この作品の放送枠はまだありません"
        initialSort={{key: 'broadcast_month', dir: 'asc'}} expandRequest={expand}
        exportSpec={{name: `放送枠_${work?.code || ''}`, title: `放送枠（${work?.title || ''}）`}}
        renderDetail={(row) => <SlotDetail row={{...row, work_title: work?.title}} request={request} isAdmin={isAdmin} canEdit={canEdit} onDone={done} />} />
      {months.length > 0 && (
        <details className="bc-months">
          <summary>月ごとに確かめる（同じ月の別の局）</summary>
          <p className="rp-muted">同じ作品・同じ月に別の局の枠がある場合に表示します。確定同士は「競合」、申請中や仮押さえを含む場合は「注意」です。</p>
          <div className="bc-month-grid">
            {months.map((month) => (
              <article className="bc-month" key={month}>
                <h4>{monthText(month)}</h4>
                {slots.filter((slot) => slot.broadcast_month === month).map((slot) => (
                  <div key={slot.slot_id} className={`bc-slot-card ${slot.conflict === 'red' ? 'is-bad' : slot.conflict === 'yellow' ? 'is-warn' : ''}`}>
                    <strong>{slot.station_name}</strong>
                    <span>{labelOf('broadcastStatus', slot.status)}・{dateJst(slot.period_from)}〜{dateJst(slot.period_to)}</span>
                    <small>{conflictText(slot.conflict)}</small>
                  </div>
                ))}
              </article>
            ))}
          </div>
        </details>
      )}
      {work && <BroadcastExcelRoundTrip kind="slots" workId={work.id} canEdit={canEdit} request={request} onCommitted={onChanged} />}
      {dialog && (
        <SlotDialog key={dialog.original?.slot_id ?? 'new'} original={dialog.original} partners={partners} agreements={workAgreements} request={request}
          initial={dialog.original ? slotFormFromRow(dialog.original) : blankSlotForm(work.id)}
          onClose={() => setDialog(null)}
          onSaved={async (result) => {
            setDialog(null);
            const station = result.stationRegistered ? '' : `（「${result.stationName}」は未登録の局として保存しました）`;
            setNotice(result.existing
              ? {tone: 'ok', title: `放送枠を第${result.revision}版として保存しました${station}`, message: '変わった項目:', details: changeNoticeDetails(result.changes)}
              : {tone: 'ok', message: `放送枠を下書きとして追加しました${station}。申請は一覧の行の「一次承認を申請」から行います`});
            await onChanged?.();
          }} />
      )}
    </section>
  );
}

// ---- 販売条件（選んでいる作品） -----------------------------------------------------------------
function ConditionHistory({request, workId, row}) {
  const [state, setState] = useState({loading: true});
  useEffect(() => {
    const q = new URLSearchParams({workId: String(workId), distributionCode: row.distribution_code, territory: row.territory});
    request(`/broadcast/conditions/history?${q}`).then((body) => setState({rows: body.rows})).catch((error) => setState({error}));
  }, [request, workId, row.distribution_code, row.territory, row.version_no]);
  if (state.loading) return <p className="rp-muted">読み込み中…</p>;
  if (state.error) return <Notice error={state.error} />;
  return (
    <ol className="bc-history">
      {state.rows.map((version) => (
        <li key={version.version_no}>
          <strong>第{version.version_no}版・{labelOf('availabilityStatus', version.status)}・{labelOf('exclusivity', version.exclusivity)}</strong>
          <span>解禁 {version.release_on ? dateJst(version.release_on) : '未確認'}〜終了 {version.sales_end_on ? dateJst(version.sales_end_on) : '未確認'}</span>
          <small>{version.terms_text || '条件未登録'}／根拠: {version.source_reference || '未登録'}・{dateTimeJst(version.created_at)}</small>
        </li>
      ))}
    </ol>
  );
}

function ConditionsPanel({request, workId, work, canEdit}) {
  const shell = useShell();
  const [catalog, setCatalog] = useState(null);
  const [loadError, setLoadError] = useState(null);
  const load = useCallback(async () => {
    try { setCatalog(await request('/sales-catalog')); setLoadError(null); } catch (error) { setLoadError(error); }
  }, [request]);
  useEffect(() => { load(); }, [workId, load]);
  const types = catalog?.types || [];
  const rows = (catalog?.rows || []).filter((row) => row.work_id === workId);
  const groups = useMemo(() => distributionGroups(types), [types]);
  // 登録・新しい版の正面入口は「流通別の販売条件」の画面。対象作品（URL の work）と ?dist=&territory=（&edit=1）で開く。
  const openFrontDoor = (params = {}) => shell.navigate('営業作品一覧', params, {workId});

  const columns = useMemo(() => [
    {key: 'group', label: '分類', type: 'text', sticky: true, value: (row) => types.find((type) => type.code === row.distribution_code)?.distribution_name || '旧区分'},
    {key: 'distribution', label: '流通', type: 'text', value: (row) => {
      const type = types.find((item) => item.code === row.distribution_code);
      return type && !type.legacy && type.distribution_name ? `${distributionLabel(type)}（${type.code}）` : distributionText(row, types);
    }},
    {key: 'territory', label: '地域', type: 'text'},
    {key: 'release_on', label: '解禁日', type: 'date'},
    {key: 'sales_end_on', label: '販売終了日', type: 'date'},
    {key: 'exclusivity', label: '独占', type: 'status', domain: 'exclusivity'},
    {key: 'status', label: '状態', type: 'status', domain: 'availabilityStatus'},
    {key: 'state', label: '今日の判定', type: 'text'},
    {key: 'terms_text', label: '販売条件', type: 'text', wrap: true},
    {key: 'source_reference', label: '根拠', type: 'text', wrap: true},
    {key: 'version_no', label: '版', type: 'int', total: 'none'},
    {key: 'actions', label: '操作', type: 'text', export: false, value: () => null, render: (row) => (canEdit
      ? <button type="button" className="secondary" onClick={() => openFrontDoor({dist: row.distribution_code, territory: row.territory, edit: '1'})}>新しい版を作る</button>
      : <span className="bc-muted">閲覧のみ</span>)},
  ], [types, canEdit, workId]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <section className="card rp-report" aria-label="流通別の販売条件">
      <header className="rp-head">
        <div>
          <h3>販売条件の一覧（{work?.title || '作品を選んでください'}）</h3>
          <p className="rp-muted">この作品の流通別の販売条件の最新版です（放送局へ出す「放送アベイルズリスト」とは別のもので、放送履歴表のタブから作ります）。登録と新しい版は「流通別の販売条件」の画面で行います（入口を1つにして、調達の根拠と地域の表記をそろえています）。行を押すと版の履歴が開きます。</p>
        </div>
        <div className="bc-action-buttons">
          {canEdit && groups.length > 0 && (
            <label className="bc-select">
              <span>流通を追加（流通区分マスタ）</span>
              <select value="" onChange={(event) => event.target.value && openFrontDoor({dist: event.target.value})}>
                <option value="">流通を選ぶ</option>
                {groups.map((group) => (
                  <optgroup key={group.group} label={group.group}>
                    {group.options.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
                  </optgroup>
                ))}
              </select>
            </label>
          )}
          <button type="button" className="secondary" onClick={() => openFrontDoor()}>流通別の販売条件を開く</button>
        </div>
      </header>
      {loadError && <Notice error={loadError} onRetry={load} />}
      {catalog && (
        <DataGrid columns={columns} rows={rows} rowKey={(row) => `${row.distribution_code}|${row.territory}`} persistKey="broadcast-conditions" ariaLabel="販売条件の一覧"
          emptyText="この作品の販売条件はまだありません" showTotals={false}
          exportSpec={{name: `販売条件_${work?.code || ''}`, title: `流通別の販売条件（${work?.title || ''}）`}}
          renderDetail={(row) => <div className="rp-drill"><ConditionHistory request={request} workId={workId} row={row} /></div>} />
      )}
      <BroadcastExcelRoundTrip kind="avails" workId={workId} canEdit={canEdit} request={request} onCommitted={load} />
    </section>
  );
}


// ---- 番販作品一覧（全作品） ---------------------------------------------------------------------
// 全作品のウィンドウ（営業基幹）の表を、放送・配信（業務用VODを含む）の種別で絞った形で出す。日付の正本はウィンドウの表で、
// 流通別の販売条件は「販売条件を開く」から作品ごとのタブで確かめる
const BROADCAST_FAMILIES = ['broadcast', 'digital'];
function CatalogPanel({onOpen}) {
  const rowAction = useCallback((row) => <button type="button" className="secondary" onClick={() => onOpen(row.work_id)}>販売条件を開く</button>, [onOpen]);
  return (
    <ReleaseWindowGrid families={BROADCAST_FAMILIES} title="番販作品一覧（全作品）" persistKey="broadcast-windows" rowAction={rowAction}
      description="全作品のウィンドウのうち、放送・配信（業務用VODを含む）の種別です。1行1作品で、ウィンドウが無い作品も「未登録」で出します。日付のセルを押すと版の履歴と新しい版の入力が出ます。流通別の販売条件は「販売条件を開く」から確かめます。" />
  );
}

// ---- 売上突合（選んでいる作品） -----------------------------------------------------------------
function ReconcilePanel({request, workId, work, canEdit, agreements, onNavigate, revision}) {
  const [data, setData] = useState(null);
  const [notice, setNotice] = useState(null);
  const [saleIds, setSaleIds] = useState({});
  const [airings, setAirings] = useState({});
  const load = useCallback(async () => {
    try { setData(await request(`/broadcast/reconciliation?workId=${workId}`)); } catch (error) { setNotice({error}); }
  }, [request, workId]);
  useEffect(() => { if (workId) load(); }, [load, workId, revision]);
  const agreementName = (id) => {
    const hit = agreements.find((agreement) => agreement.id === id);
    return hit ? `${hit.contract_code}・${hit.title}` : '未紐付け';
  };

  async function recordAiring(row) {
    const input = airings[row.slot_id] || {};
    try {
      await request(`/broadcast/slots/${row.slot_id}/airings`, {method: 'POST', body: JSON.stringify({airedOn: input.date, runCount: input.count || 1, sourceReference: input.source})});
      setNotice({tone: 'ok', message: `${row.station_name}の実放送（${dateJst(input.date)}・${input.count || 1}回）を根拠付きで記録しました`});
      setAirings((current) => ({...current, [row.slot_id]: {}}));
      await load();
    } catch (error) {
      setNotice({error});
    }
  }

  async function linkSale(row) {
    try {
      await request(`/broadcast/slots/${row.slot_id}/sales`, {method: 'POST', body: JSON.stringify({saleId: saleIds[row.slot_id]})});
      setNotice({tone: 'ok', message: `報告売上を${row.station_name}（${monthText(row.broadcast_month)}）の放送枠へ紐付けました`});
      await load();
    } catch (error) {
      setNotice({error});
    }
  }

  const setAiring = (slotId, key, value) => setAirings((current) => ({...current, [slotId]: {...current[slotId], [key]: value}}));
  return (
    <section className="card rp-report" aria-label="売上突合">
      <header className="rp-head">
        <div>
          <h3>売上突合（{work?.title || '作品を選んでください'}）</h3>
          <p className="rp-muted">確定した放送枠に、放送報告の売上明細と実放送を紐付けます。契約の見込額から売上は作りません。</p>
        </div>
        <button type="button" className="secondary" onClick={load}>再読込</button>
      </header>
      {notice && <Notice tone={notice.tone} message={notice.message} error={notice.error} onDismiss={() => setNotice(null)} />}
      <div className="bc-cards">
        {(data?.rows || []).map((row) => (
          <article className="bc-card" key={row.slot_id}>
            <div className="bc-card-main">
              <h4>{monthText(row.broadcast_month)}・{row.station_name}</h4>
              <p>{labelOf('broadcastStatus', row.status)}／予定 {row.planned_runs}回／実放送 {row.actual_runs}回／売上 {row.sales.length}件・{yen(row.linked_amount_ex_tax)}</p>
              <p className="rp-muted">契約 {agreementName(row.agreement_id)}／納品 {row.delivery.map((item) => `${labelOf('deliverableStatus', item.status)} ${item.count}件`).join('、') || '未紐付け'}</p>
              <span className={`bc-flag ${RECONCILE_TONE[row.reconciliation] || ''}`}>{RECONCILE_TEXT[row.reconciliation] || '確認待ち'}</span>
              {row.sales.length > 0 && <button type="button" className="secondary" onClick={() => onNavigate?.('売上')}>売上明細を開く</button>}
            </div>
            {canEdit && (
              <div className="bc-card-form">
                <FormField type="select" label="放送報告の売上" blankLabel="報告売上を選ぶ" value={saleIds[row.slot_id] || ''}
                  options={(data?.surplus || []).map((sale) => ({value: String(sale.id), label: `${sale.report_key}・${monthText(sale.accounting_month)}／${sale.partner_name}／${yen(sale.amount_ex_tax)}`}))}
                  onChange={(value) => setSaleIds((current) => ({...current, [row.slot_id]: value}))} />
                <button type="button" onClick={() => linkSale(row)} disabled={!saleIds[row.slot_id]}>売上を紐付ける</button>
                {row.status === 'confirmed' && (
                  <>
                    <FormField type="date" label="実放送日" value={airings[row.slot_id]?.date || ''} onChange={(value) => setAiring(row.slot_id, 'date', value)} />
                    <FormField type="int" label="回数" value={airings[row.slot_id]?.count || '1'} onChange={(value) => setAiring(row.slot_id, 'count', value)} />
                    <FormField label="実績の根拠" value={airings[row.slot_id]?.source || ''} onChange={(value) => setAiring(row.slot_id, 'source', value)} />
                    <button type="button" onClick={() => recordAiring(row)} disabled={!airings[row.slot_id]?.date || !airings[row.slot_id]?.source}>実放送を記録する</button>
                  </>
                )}
              </div>
            )}
          </article>
        ))}
        {data && !data.rows.length && <p className="rp-muted">この作品の放送枠はまだありません。</p>}
      </div>
      <h4>放送報告にあり、放送枠に未紐付けの売上</h4>
      <DataGrid rows={data?.surplus || []} rowKey="id" ariaLabel="未紐付けの放送売上" emptyText="未紐付けの放送売上はありません"
        columns={[
          {key: 'report_key', label: '報告', type: 'code'},
          {key: 'accounting_month', label: '計上月', type: 'month'},
          {key: 'partner_name', label: '取引先', type: 'text'},
          {key: 'amount_ex_tax', label: '税抜額', type: 'yen'},
        ]} />
    </section>
  );
}

// ---- 画面 ---------------------------------------------------------------------------------------
export default function BroadcastWorkspace({request: requestProp, data, onSelect, onNavigate}) {
  const shell = useShell();
  const request = requestProp || shell.request;
  const readOnly = Boolean(shell.readOnly);
  const [payload, setPayload] = useState(null);
  const [loadError, setLoadError] = useState(null);
  const [tab, setTab] = useState(() => shell.getParam('tab', 'history'));
  const focusMonth = shell.getParam('bcmonth', null);
  const [revision, setRevision] = useState(0);
  const workId = Number(data?.selectedWorkId || payload?.works?.[0]?.id || 0);
  const work = payload?.works?.find((item) => item.id === workId) || null;
  const canEdit = Boolean(work?.canEdit) && !readOnly;
  const isAdmin = Boolean(payload?.approvalRole) && !readOnly;
  const slots = useMemo(() => (payload?.slots || []).filter((slot) => slot.work_id === workId), [payload, workId]);
  const pending = (payload?.slots || []).filter((slot) => isPendingApproval(slot.status)).length;

  const load = useCallback(async () => {
    try {
      const body = await request('/broadcast');
      setPayload(body);
      setLoadError(null);
      setRevision((n) => n + 1);
      if (!data?.selectedWorkId && body.works.length) onSelect?.(body.works[0].id);
    } catch (error) {
      setLoadError(error);
    }
  }, [request, data?.selectedWorkId, onSelect]);
  useEffect(() => { load(); }, [data?.selectedWorkId]); // eslint-disable-line react-hooks/exhaustive-deps

  const goTab = (id) => { setTab(id); shell.setParam('tab', id, {replace: true}); };
  const openWork = (id, next = 'conditions') => { onSelect?.(Number(id)); goTab(next); };
  // 放送履歴表のセルから: その作品を選び、放送枠のタブをその月で開く
  const openSlots = (id, ym) => { shell.setParam('bcslot', null, {replace: true}); shell.setParam('bcmonth', ym, {replace: true}); openWork(id, 'slots'); };
  // 放送ウィンドウ提案の「提案から作った下書き」から: その作品を選び、放送枠のタブをその月で開いて、その枠の行（申請のボタン）を開く。
  // 同じ作品のときは作品を替えても読み直しが走らないので、先に画面全体を読み直してから移る（提案のタブで作った・消した下書きを今の状態で出す）
  const openSlot = async (id, ym, slotId) => {
    shell.setParam('bcmonth', ym, {replace: true});
    shell.setParam('bcslot', String(slotId), {replace: true});
    if (Number(id) === workId) await load();
    openWork(id, 'slots');
  };
  const clearFocus = () => { shell.setParam('bcmonth', null, {replace: true}); shell.setParam('bcslot', null, {replace: true}); };
  const focusSlot = Number(shell.getParam('bcslot', null)) || null;

  const tabs = [
    {id: 'history', label: '放送履歴表'},
    {id: 'catalog', label: '番販作品一覧'},
    {id: 'conditions', label: '販売条件の一覧'},
    {id: 'slots', label: '放送枠', badge: slots.length || undefined},
    {id: 'approvals', label: '承認待ち（全作品）', badge: pending || undefined},
    {id: 'reconcile', label: '売上突合'},
    {id: 'proposals', label: '放送ウィンドウ提案'},
  ];

  return (
    <section className="bc-workspace">
      <header className="bc-heading">
        <div>
          <h2>作品の販売と放送予定</h2>
          <p className="rp-muted">放送履歴表・番販作品一覧・承認待ちは全作品、販売条件の一覧・放送枠・売上突合は画面上部の「対象作品」で選んだ作品を表示します。放送ウィンドウ提案は選んでいる作品か全作品を選べます。</p>
        </div>
        {work && <p className="bc-current">対象作品: <strong>{work.title}</strong>（{work.code}）{!work.canEdit && <span className="bc-badge">閲覧のみ</span>}</p>}
      </header>
      {loadError && <Notice error={loadError} onRetry={load} />}
      {payload && !payload.works.length && <Notice tone="info" message="閲覧できる作品がありません。案件の権限を管理者に確かめてください。" />}
      <Tabs tabs={tabs} value={tab} urlKey="tab" label="番販業務" onChange={setTab}>
        {(active) => {
          if (!payload) return <p className="rp-muted">読み込み中…</p>;
          if (active === 'history') return <BroadcastHistory request={request} onOpenSlots={openSlots} />;
          if (active === 'catalog') return <CatalogPanel onOpen={(id) => openWork(id, 'conditions')} />;
          if (active === 'conditions') return <ConditionsPanel request={request} workId={workId} work={work} canEdit={canEdit} />;
          if (active === 'slots') return <SlotsPanel work={work} slots={slots} partners={payload.partners || []} agreements={payload.agreements || []} request={request} isAdmin={isAdmin} canEdit={canEdit} onChanged={load} focusMonth={focusMonth} focusSlot={focusSlot} onClearFocus={clearFocus} />;
          if (active === 'approvals') return <BroadcastApprovals request={request} onChanged={load} onOpenWork={(id) => openWork(id, 'slots')} />;
          if (active === 'reconcile') return <ReconcilePanel request={request} workId={workId} work={work} canEdit={canEdit} agreements={payload.agreements || []} onNavigate={onNavigate} revision={revision} />;
          if (active === 'proposals') return <WindowProposals request={request} workId={workId} work={work} readOnly={readOnly} onOpenSlot={openSlot} onChanged={load} />;
          return null;
        }}
      </Tabs>
    </section>
  );
}
