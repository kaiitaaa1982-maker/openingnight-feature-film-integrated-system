// ロイヤリティ契約（契約・条件版・サイクル・実額の計上・イレギュラー）。
// 契約は作品×権利者×種別。条件（料率・基礎・対象流通・前払金・下限）とサイクル（締め方・報告と支払の期限）は版で持ち、変えるときは新しい版を足す。
// 実額の計上（音楽著作権料など）とイレギュラー（金額の調整・締め月の変更・保留・解除・記録）は台帳に足し、取り消すときは取消の行を足す。
import React, {useEffect, useId, useMemo, useState} from 'react';
import {useShell} from '../shell/context.mjs';
import {DataGrid} from '../ui/DataGrid.jsx';
import {FormField} from '../ui/FormField.jsx';
import {EntityPicker} from '../ui/EntityPicker.jsx';
import {RecordForm} from '../ui/RecordForm.jsx';
import {Notice} from '../ui/Notice.jsx';
import {Tabs} from '../ui/Tabs.jsx';
import {ReportOutputBar} from '../ui/ReportOutputBar.jsx';
import {gridSheetSpec} from '../ui/grid-model.mjs';
import {toEntityItems} from '../ui/entity-match.mjs';
import {yen, dateTimeJst, month as monthText} from '../ui/format.mjs';
import {rateText} from './royalty-model.mjs';
import {
  CATEGORY_OPTIONS, IRREGULAR_KIND_OPTIONS, emptyTerm, termFromVersion, termPayload, emptyPhase, phaseFromSaved, phasePayload, fieldErrorsOf,
} from './royalty-ui.mjs';
import {TermFields, PhaseEditor, ErrorNotice, ReasonAction} from './RoyaltyParts.jsx';
import '../reports/reports.css';
import './royalty.css';

const AGREEMENT_COLUMNS = [
  {key: 'code', label: '契約コード', type: 'code', sticky: true},
  {key: 'title', label: '契約名', type: 'text'},
  {key: 'workTitle', label: '作品', type: 'text'},
  {key: 'holderName', label: '権利者', type: 'text'},
  {key: 'categoryLabel', label: '種別', type: 'text'},
  {key: 'termText', label: '条件（いま効いている版）', type: 'text', wrap: true},
  {key: 'channelText', label: '対象の流通', type: 'text', wrap: true},
  {key: 'cycleText', label: 'サイクル', type: 'text', wrap: true},
  {key: 'reportText', label: '報告期限', type: 'text'},
  {key: 'paymentText', label: '支払期限', type: 'text'},
  {key: 'advanceYen', label: '前払金', type: 'yen'},
  {key: 'minPaymentYen', label: '支払の下限', type: 'text', value: (r) => (r.minPaymentYen === null || r.minPaymentYen === undefined ? '下限なし' : yen(r.minPaymentYen))},
  {key: 'documentReference', label: '契約書', type: 'text', hidden: true, value: (r) => r.documentReference || ''},
];
const TERM_COLUMNS = [
  {key: 'versionNo', label: '版', type: 'int', total: 'none', sticky: true},
  {key: 'effectiveFrom', label: '適用開始', type: 'month'},
  {key: 'summary', label: '条件', type: 'text', wrap: true},
  {key: 'channelText', label: '対象の流通', type: 'text', wrap: true},
  {key: 'expenseCategories', label: '差し引く経費の費目', type: 'text', wrap: true, value: (r) => (r.expenseCategories?.length ? r.expenseCategories.join('、') : r.baseKind?.endsWith('expenses') ? 'その月の経費すべて' : '—')},
  {key: 'advanceYen', label: '前払金', type: 'yen', total: 'none'},
  {key: 'minPaymentYen', label: '支払の下限', type: 'text', value: (r) => (r.minPaymentYen === null || r.minPaymentYen === undefined ? '下限なし' : yen(r.minPaymentYen))},
  {key: 'clauseReference', label: '根拠の条項', type: 'text'},
  {key: 'reason', label: '理由', type: 'text', wrap: true, value: (r) => r.reason || ''},
  {key: 'createdAt', label: '登録', type: 'datetime'},
];
const PHASE_COLUMNS = [
  {key: 'startsMonth', label: '開始', type: 'month', sticky: true},
  {key: 'endsMonth', label: '終了', type: 'text', value: (r) => (r.endsMonth ? monthText(r.endsMonth) : '以降ずっと')},
  {key: 'cycleText', label: 'サイクル', type: 'text', wrap: true},
  {key: 'reportText', label: '報告期限', type: 'text'},
  {key: 'paymentText', label: '支払期限', type: 'text'},
  {key: 'note', label: 'メモ', type: 'text', wrap: true, value: (r) => r.note || ''},
];
const MANUAL_COLUMNS = [
  {key: 'accrualMonth', label: '計上月', type: 'month', sticky: true},
  {key: 'amountYen', label: '金額', type: 'yen'},
  {key: 'sourceReference', label: '元資料', type: 'text'},
  {key: 'reason', label: '理由', type: 'text', wrap: true},
  {key: 'state', label: '行', type: 'text', value: (r) => (r.reversesEntryId ? '取消の行' : r.reversed ? '取消済み' : '有効')},
  {key: 'createdAt', label: '登録', type: 'datetime'},
];
const IRREGULAR_COLUMNS = [
  {key: 'id', label: '記録', type: 'int', total: 'none', sticky: true},
  {key: 'kindLabel', label: '種類', type: 'text'},
  {key: 'agreementCode', label: '対象', type: 'text', value: (r) => (r.agreementCode ? 'この契約' : '権利者全体')},
  {key: 'accrualMonth', label: '計上月', type: 'month', value: (r) => r.accrualMonth || null},
  {key: 'closeMonth', label: '締め月', type: 'month', value: (r) => r.closeMonth || null},
  {key: 'amountYen', label: '金額', type: 'yen', total: 'none'},
  {key: 'effect', label: 'その結果', type: 'text', wrap: true},
  {key: 'reason', label: '理由', type: 'text', wrap: true},
  {key: 'sourceReference', label: '根拠の資料', type: 'text', value: (r) => r.sourceReference || ''},
];
const ACCRUAL_COLUMNS = [
  {key: 'accrualMonth', label: '計上月', type: 'month', sticky: true},
  {key: 'closeMonth', label: '締め月', type: 'month', value: (r) => r.closeMonth || null},
  {key: 'salesYen', label: '対象の売上', type: 'yen'},
  {key: 'windowFeeYen', label: '窓口手数料', type: 'yen'},
  {key: 'expenseYen', label: '経費の控除', type: 'yen'},
  {key: 'baseYen', label: '基礎の額', type: 'yen'},
  {key: 'rate', label: '料率', type: 'text', value: (r) => (r.rateBps === null || r.rateBps === undefined ? '—' : rateText(r.rateBps))},
  {key: 'royaltyYen', label: '発生額', type: 'yen'},
  {key: 'holdSalesYen', label: '保留の対象売上', type: 'yen'},
  {key: 'status', label: '状態', type: 'text'},
  {key: 'holdReason', label: '保留の理由', type: 'text', wrap: true},
];
const CLOSING_COLUMNS = [
  {key: 'closeMonth', label: '締め月', type: 'month', sticky: true},
  {key: 'reportDueOn', label: '報告期限', type: 'date'},
  {key: 'paymentDueOn', label: '支払期限', type: 'date'},
];
const TARGET_OPTIONS = [{value: 'agreement', label: 'この契約'}, {value: 'holder', label: '権利者全体（契約に付けない）'}];

function useUnsaved(label, dirty) {
  const shell = useShell();
  const id = `ry${useId().replace(/:/g, '')}`;
  useEffect(() => { shell.registerUnsaved?.(id, dirty ? 1 : 0, label); }, [dirty, id, label, shell]);
  useEffect(() => () => shell.registerUnsaved?.(id, 0, label), [id]); // eslint-disable-line react-hooks/exhaustive-deps
}

function AgreementCreate({data, expenseCategories, request, onCreated, onCancel}) {
  const blank = useMemo(() => ({workId: null, holderId: null, category: 'director', code: '', title: '', documentReference: '', note: '', statementsFrom: ''}), []);
  const [values, setValues] = useState(blank);
  const [term, setTerm] = useState(emptyTerm(''));
  const [phases, setPhases] = useState([emptyPhase('')]);
  const [errors, setErrors] = useState({});
  const [error, setError] = useState(null);
  const [saving, setSaving] = useState(false);
  const dirty = JSON.stringify(values) !== JSON.stringify(blank) || JSON.stringify(term) !== JSON.stringify(emptyTerm('')) || phases.length > 1 || phases[0].startsMonth !== '';
  useUnsaved('ロイヤリティ契約の新規登録', dirty);
  const set = (key) => (next) => setValues((previous) => ({...previous, [key]: next}));
  function changeTerm(next) {
    // 最初のフェーズの開始月が未入力か適用開始と同じなら、適用開始に合わせる
    if (phases[0] && (!phases[0].startsMonth || phases[0].startsMonth === term.effectiveFrom)) setPhases((list) => list.map((phase, index) => (index === 0 ? {...phase, startsMonth: next.effectiveFrom} : phase)));
    setTerm(next);
  }
  async function submit() {
    const local = {};
    if (!values.workId) local.workId = '作品を選んでください';
    if (!values.holderId) local.holderPartnerId = '権利者（取引先）を選んでください';
    const {payload, errors: termErrors} = termPayload(term);
    const merged = {...local, ...Object.fromEntries(Object.entries(termErrors).map(([k, v]) => [`term.${k}`, v]))};
    if (Object.keys(merged).length) { setErrors(merged); setError(null); return; }
    setSaving(true);
    setErrors({});
    setError(null);
    try {
      const result = await request('/royalty/agreements', {method: 'POST', body: JSON.stringify({
        workId: values.workId, holderPartnerId: values.holderId, category: values.category, agreementCode: values.code, title: values.title,
        documentReference: values.documentReference, note: values.note, term: payload,
        schedule: {statementsFrom: values.statementsFrom || null, phases: phases.map(phasePayload)},
      })});
      setValues(blank); setTerm(emptyTerm('')); setPhases([emptyPhase('')]);
      onCreated?.(result.agreementId);
    } catch (cause) {
      setErrors(fieldErrorsOf(cause));
      setError(cause);
    } finally { setSaving(false); }
  }
  const termErrors = Object.fromEntries(Object.entries(errors).filter(([k]) => k.startsWith('term.')).map(([k, v]) => [k.slice(5), v]));
  const phaseErrors = Object.fromEntries(Object.entries(errors).filter(([k]) => k.startsWith('schedule.')).map(([k, v]) => [k.slice(9), v]));
  return (
    <section className="subform stack" aria-label="ロイヤリティ契約の新規登録">
      <h3>新しいロイヤリティ契約</h3>
      <fieldset disabled={saving} className="on-form-grid">
        <EntityPicker label="作品" required items={toEntityItems(data?.works || [])} value={values.workId} onChange={set('workId')} error={errors.workId} />
        <EntityPicker label="権利者（取引先）" required items={toEntityItems(data?.partners || [])} value={values.holderId} onChange={set('holderId')} error={errors.holderPartnerId}
          hint="監督・脚本家・音楽出版社・原作者などを取引先として登録しておきます" />
        <FormField type="select" label="種別" required value={values.category} includeBlank={false} options={CATEGORY_OPTIONS} onChange={set('category')} error={errors.category} />
        <FormField type="text" label="契約コード" required value={values.code} onChange={set('code')} error={errors.agreementCode} placeholder="例: RY-2026-001" />
        <FormField type="text" label="契約名" required wide value={values.title} onChange={set('title')} error={errors.title} />
        <FormField type="text" label="契約書の参照先" value={values.documentReference} onChange={set('documentReference')} error={errors.documentReference} placeholder="例: 共有フォルダの契約書名・版" />
        <FormField type="text" label="メモ" value={values.note} onChange={set('note')} error={errors.note} />
      </fieldset>
      <h4>条件（第1版）</h4>
      <TermFields value={term} onChange={changeTerm} errors={termErrors} expenseCategories={expenseCategories} disabled={saving} />
      <h4>サイクル（締め方と、報告・支払の期限）</h4>
      <PhaseEditor phases={phases} onChange={setPhases} errors={phaseErrors} disabled={saving} />
      <FormField type="month" label="報告書を作り始める締め月（移行用・空欄はすべて作る）" value={values.statementsFrom} onChange={set('statementsFrom')} error={phaseErrors.statementsFrom}
        hint="以前の仕組みで報告済みの期間があるときだけ入れます。この締め月より前の期間は報告書を作りません" />
      <ErrorNotice error={error} />
      <div className="on-form-actions">
        <button type="button" disabled={saving} onClick={submit}>{saving ? '登録中…' : '契約を登録'}</button>
        <button type="button" className="text" disabled={saving} onClick={onCancel}>閉じる</button>
      </div>
    </section>
  );
}

function TermVersionForm({agreementId, latest, expenseCategories, request, onSaved}) {
  const initial = useMemo(() => (latest ? termFromVersion(latest) : emptyTerm('')), [latest]);
  const [term, setTerm] = useState(initial);
  const [errors, setErrors] = useState({});
  const [error, setError] = useState(null);
  const [saving, setSaving] = useState(false);
  const [open, setOpen] = useState(false);
  useUnsaved('条件版の追加', open && JSON.stringify(term) !== JSON.stringify(initial));
  if (!open) return <button type="button" className="secondary" onClick={() => setOpen(true)}>＋条件版を足す（料率・基礎などを変える）</button>;
  async function submit() {
    const {payload, errors: local} = termPayload(term);
    if (Object.keys(local).length) { setErrors(local); return; }
    setSaving(true); setError(null); setErrors({});
    try {
      await request(`/royalty/agreements/${agreementId}/terms`, {method: 'POST', body: JSON.stringify(payload)});
      setOpen(false); setTerm(initial);
      onSaved?.();
    } catch (cause) { setErrors(fieldErrorsOf(cause)); setError(cause); } finally { setSaving(false); }
  }
  return (
    <section className="subform stack" aria-label="条件版の追加">
      <h4>条件版を足す</h4>
      <p className="rp-muted">前の版は残ります。適用開始の計上月から新しい条件で計算します。報告済みの月に効く変更は、差額を次の報告書に「報告後の修正」として入れます。</p>
      <TermFields value={term} onChange={setTerm} errors={errors} expenseCategories={expenseCategories} showReason disabled={saving} />
      <ErrorNotice error={error} />
      <div className="on-form-actions">
        <button type="button" disabled={saving} onClick={submit}>{saving ? '登録中…' : 'この条件版を登録'}</button>
        <button type="button" className="text" disabled={saving} onClick={() => { setOpen(false); setTerm(initial); setErrors({}); }}>やめる</button>
      </div>
    </section>
  );
}

function ScheduleVersionForm({agreementId, latest, request, onSaved}) {
  const initial = useMemo(() => (latest?.phases?.length ? latest.phases.map(phaseFromSaved) : [emptyPhase('')]), [latest]);
  const [phases, setPhases] = useState(initial);
  const [statementsFrom, setStatementsFrom] = useState(latest?.statementsFrom || '');
  const [reason, setReason] = useState('');
  const [errors, setErrors] = useState({});
  const [error, setError] = useState(null);
  const [saving, setSaving] = useState(false);
  const [open, setOpen] = useState(false);
  useUnsaved('サイクルの版の追加', open && (JSON.stringify(phases) !== JSON.stringify(initial) || Boolean(reason)));
  if (!open) return <button type="button" className="secondary" onClick={() => setOpen(true)}>＋サイクルの版を足す（締め方・期限を変える）</button>;
  async function submit() {
    setSaving(true); setError(null); setErrors({});
    try {
      await request(`/royalty/agreements/${agreementId}/schedules`, {method: 'POST', body: JSON.stringify({statementsFrom: statementsFrom || null, reason, phases: phases.map(phasePayload)})});
      setOpen(false); setReason('');
      onSaved?.();
    } catch (cause) { setErrors(fieldErrorsOf(cause)); setError(cause); } finally { setSaving(false); }
  }
  return (
    <section className="subform stack" aria-label="サイクルの版の追加">
      <h4>サイクルの版を足す</h4>
      <p className="rp-muted">新しい版がすべての計上月の締め方を決めます（前の版は残り、確定済みの報告書は変わりません）。途中でサイクルが変わる契約は、フェーズを分けて入れます（例: 2024年7月〜2025年3月は半年、2025年4月からは四半期）。</p>
      <PhaseEditor phases={phases} onChange={setPhases} errors={errors} disabled={saving} />
      <div className="on-form-grid">
        <FormField type="month" label="報告書を作り始める締め月（移行用・空欄はすべて作る）" value={statementsFrom} onChange={setStatementsFrom} error={errors.statementsFrom} />
        <FormField type="textarea" label="サイクルを変える理由" required value={reason} onChange={setReason} error={errors.reason} rows={2} />
      </div>
      <ErrorNotice error={error} />
      <div className="on-form-actions">
        <button type="button" disabled={saving} onClick={submit}>{saving ? '登録中…' : 'このサイクルの版を登録'}</button>
        <button type="button" className="text" disabled={saving} onClick={() => { setOpen(false); setPhases(initial); setErrors({}); }}>やめる</button>
      </div>
    </section>
  );
}

function AgreementDetail({id, expenseCategories, onChanged}) {
  const shell = useShell();
  const request = shell.request;
  const [state, setState] = useState({loading: true});
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    let live = true;
    setState((previous) => ({...previous, loading: true, error: null}));
    request(`/royalty/agreements/${id}`).then((body) => live && setState({body})).catch((error) => live && setState({error}));
    return () => { live = false; };
  }, [id, request, revision]);
  const reload = () => { setRevision((n) => n + 1); onChanged?.(); };
  const body = state.body;
  if (state.error) return <section className="card"><ErrorNotice error={state.error} /></section>;
  if (!body) return <section className="card"><p className="rp-muted" aria-busy="true">読み込み中…</p></section>;
  const a = body.agreement;
  const hasManual = body.terms.some((term) => term.calcMethod === 'manual');
  const latestSchedule = body.schedules.at(-1) || null;
  const readOnly = shell.readOnly;
  const title = `${a.code} ${a.title}`;
  const sheets = () => [
    gridSheetSpec({columns: TERM_COLUMNS, rows: body.terms, showTotals: false, exportSpec: {name: '条件版', title: `${title} 条件版`}}),
    ...body.schedules.map((schedule) => gridSheetSpec({columns: PHASE_COLUMNS, rows: schedule.phases, showTotals: false,
      exportSpec: {name: `サイクル第${schedule.versionNo}版`, title: `${title} サイクル 第${schedule.versionNo}版`, notes: [schedule.reason || '', schedule.statementsFrom ? `報告書を作り始める締め月: ${monthText(schedule.statementsFrom)}` : ''].filter(Boolean)}})),
    gridSheetSpec({columns: ACCRUAL_COLUMNS, rows: body.accruals, exportSpec: {name: '計上月', title: `${title} 計上月ごとの発生額`}}),
    gridSheetSpec({columns: IRREGULAR_COLUMNS, rows: body.irregularEntries, showTotals: false, exportSpec: {name: 'イレギュラー', title: `${title} イレギュラー`}}),
    gridSheetSpec({columns: MANUAL_COLUMNS, rows: body.manualAccruals, exportSpec: {name: '実額の計上', title: `${title} 実額の計上`}}),
  ];
  const tabs = [
    {id: 'terms', label: '条件版', badge: body.terms.length}, {id: 'schedule', label: 'サイクル', badge: body.schedules.length},
    {id: 'accruals', label: '計上月と締め月', badge: body.accruals.length || undefined}, {id: 'irregular', label: 'イレギュラー', badge: body.irregularEntries.length || undefined},
    {id: 'manual', label: '実額の計上', badge: body.manualAccruals.length || undefined},
  ];
  const irregularFields = [
    {name: 'kind', label: '記録の種類', type: 'select', required: true, options: IRREGULAR_KIND_OPTIONS, defaultValue: 'adjust_amount', keep: true},
    {name: 'target', label: '対象', type: 'select', required: true, options: TARGET_OPTIONS, defaultValue: 'agreement', visible: (raw) => raw.kind === 'adjust_amount' || raw.kind === 'note'},
    {name: 'accrualMonth', label: '計上月', type: 'month', required: true, visible: (raw) => ['move_period', 'hold', 'release'].includes(raw.kind)},
    {name: 'closeMonth', label: '報告書に入れる締め月', type: 'month', required: true, visible: (raw) => raw.kind === 'adjust_amount' || raw.kind === 'move_period',
      hint: '作成済みの報告書より後の締め月にします'},
    {name: 'amountYen', label: '調整する金額（減らすときはマイナス）', type: 'yen', required: true, allowNegative: true, visible: (raw) => raw.kind === 'adjust_amount'},
    {name: 'sourceReference', label: '根拠の資料（合意のメールなど）', type: 'text'},
    {name: 'reason', label: '理由', type: 'textarea', required: true, wide: true},
  ];
  const kindHint = {
    adjust_amount: '締め月の報告書に調整の行として入ります（前払金の充当の対象にはしません）。',
    move_period: 'その計上月の分を、指定した締め月の報告書へ移します（報告済みの計上月は移せません）。',
    hold: 'その計上月の分を報告書に入れず、保留として別に示します。',
    release: '保留を解くと、次に作る報告書に遅れて入ります。',
    note: '金額や締め月は変えず、記録だけを残します。',
  };
  return (
    <section className="card rp-report" aria-label={title}>
      <header className="rp-head">
        <div>
          <h2>{title}</h2>
          <p className="rp-muted">{a.workTitle}・{a.holderName}・{a.categoryLabel}{a.documentReference ? `・契約書: ${a.documentReference}` : ''}</p>
        </div>
        <ReportOutputBar sheets={sheets} name={`ロイヤリティ契約_${a.code}`} title={title} formats={['xlsx', 'print']} />
      </header>
      <dl className="ry-kv">
        <div><dt>いまの条件</dt><dd>{a.termText}</dd></div>
        <div><dt>対象の流通</dt><dd>{a.channelText}</dd></div>
        <div><dt>サイクル</dt><dd>{a.cycleText}</dd></div>
        <div><dt>報告・支払</dt><dd>{a.reportText}・{a.paymentText}</dd></div>
        <div><dt>前払金・支払の下限</dt><dd>{yen(a.advanceYen)}・{a.minPaymentYen === null ? '下限なし' : yen(a.minPaymentYen)}</dd></div>
        <div><dt>今月までの発生額の累計</dt><dd>{yen(body.ledgerTotals.cumulativeYen)}</dd></div>
      </dl>
      {body.restricted && <Notice tone="info" compact message="この権利者は、財務権限のない作品の契約も持つため、報告書は表示しません（契約と計上月は確かめられます）。" />}
      {a.note && <p className="rp-muted">メモ: {a.note}</p>}
      <Tabs tabs={tabs} urlKey="atab" label="契約の内容">
        {(active) => {
          if (active === 'terms') return (
            <div className="stack">
              <DataGrid columns={TERM_COLUMNS} rows={body.terms} rowKey="id" showTotals={false} persistKey="royalty-terms" />
              {!readOnly && <TermVersionForm agreementId={a.id} latest={body.terms.at(-1)} expenseCategories={expenseCategories} request={request} onSaved={reload} />}
            </div>
          );
          if (active === 'schedule') return (
            <div className="stack">
              {[...body.schedules].reverse().map((schedule) => (
                <div key={schedule.id} className="stack" style={{gap: 6}}>
                  <h4>サイクル 第{schedule.versionNo}版{schedule === latestSchedule ? '（いま使う版）' : ''}</h4>
                  <p className="rp-muted">{dateTimeJst(schedule.createdAt)}・{schedule.createdByName || ''}{schedule.reason ? `・理由: ${schedule.reason}` : ''}{schedule.statementsFrom ? `・報告書を作り始める締め月: ${monthText(schedule.statementsFrom)}` : ''}</p>
                  <DataGrid columns={PHASE_COLUMNS} rows={schedule.phases} rowKey="id" showTotals={false} persistKey="royalty-phases" />
                </div>
              ))}
              {!readOnly && <ScheduleVersionForm agreementId={a.id} latest={latestSchedule} request={request} onSaved={reload} />}
              <h4>今月までの締め月と期限</h4>
              <DataGrid columns={CLOSING_COLUMNS} rows={body.closings} rowKey="closeMonth" showTotals={false} persistKey="royalty-closings" maxHeight="30vh" emptyText="締め月はまだありません" />
            </div>
          );
          if (active === 'accruals') return (
            <div className="stack">
              <p className="rp-muted">計上月ごとの発生額と、締め月・報告の状態です（今月まで）。保留の分は0円にせず、対象売上を残します。</p>
              <DataGrid columns={ACCRUAL_COLUMNS} rows={body.accruals} rowKey="key" persistKey="royalty-agreement-accruals" maxHeight="50vh" emptyText="この契約の発生額はまだありません" />
            </div>
          );
          if (active === 'irregular') return (
            <div className="stack">
              <DataGrid columns={IRREGULAR_COLUMNS} rows={body.irregularEntries} rowKey="key" showTotals={false} persistKey="royalty-agreement-irregular" emptyText="イレギュラーの記録はありません"
                renderDetail={(row) => (row.isReversal || row.reversed || readOnly ? <p className="rp-muted">{row.isReversal ? '取消の記録です。' : row.reversed ? '取消済みです。' : ''}</p> : (
                  <ReasonAction label="この記録を取り消す" confirmTitle="この記録を取り消しますか" confirmText={`${row.kindLabel}（記録${row.id}）を取り消します。報告済みの調整を取り消すと、次の報告書に戻しの行が入ります`}
                    onConfirm={(reason) => request(`/royalty/irregular-entries/${row.id}/reverse`, {method: 'POST', body: JSON.stringify({reason})}).then(reload)} />
                ))} />
              {!readOnly && (
                <RecordForm mode="create" openLabel="＋イレギュラーを記録" title="イレギュラーを記録" submitLabel="記録する" successMessage="記録しました" fields={irregularFields}
                  onSubmit={(v) => request('/royalty/irregular-entries', {method: 'POST', body: JSON.stringify({
                    kind: v.kind, agreementId: (v.kind === 'adjust_amount' || v.kind === 'note') && v.target === 'holder' ? null : a.id, holderPartnerId: a.holderId,
                    accrualMonth: v.accrualMonth ?? null, closeMonth: v.closeMonth ?? null, amountYen: v.amountYen ?? null, reason: v.reason, sourceReference: v.sourceReference ?? null,
                  })})}
                  onSaved={reload} />
              )}
              <ul className="rp-muted">{Object.entries(kindHint).map(([kind, text]) => <li key={kind}>{IRREGULAR_KIND_OPTIONS.find((o) => o.value === kind)?.label}: {text}</li>)}</ul>
            </div>
          );
          return (
            <div className="stack">
              {!hasManual && <Notice tone="info" compact message="この契約には計算方法が「実額入力」の条件版がありません。実額の計上は、実額入力の版の月だけに使えます（料率の月を直すときはイレギュラーの「金額の調整」を使います）。" />}
              <DataGrid columns={MANUAL_COLUMNS} rows={body.manualAccruals} rowKey="id" persistKey="royalty-manual" emptyText="実額の計上はありません"
                renderDetail={(row) => (row.reversesEntryId || row.reversed || readOnly ? <p className="rp-muted">{row.reversesEntryId ? '取消の行です。' : row.reversed ? '取消済みです。' : ''}</p> : (
                  <ReasonAction label="この計上を取り消す" confirmTitle="この計上を取り消しますか" confirmText={`${monthText(row.accrualMonth)}の ${yen(row.amountYen)}（${row.sourceReference}）を取り消します`}
                    onConfirm={(reason) => request(`/royalty/manual-accruals/${row.id}/reverse`, {method: 'POST', body: JSON.stringify({reason})}).then(reload)} />
                ))} />
              {!readOnly && hasManual && (
                <RecordForm mode="create" openLabel="＋実額を計上" title="実額を計上（分配明細などの額）" submitLabel="計上する" successMessage="計上しました"
                  fields={[
                    {name: 'accrualMonth', label: '計上月', type: 'month', required: true, keep: true},
                    {name: 'amountYen', label: '金額（戻しはマイナス）', type: 'yen', required: true, allowNegative: true},
                    {name: 'sourceReference', label: '元資料（分配明細の番号など）', type: 'text', required: true, keep: true},
                    {name: 'reason', label: '理由', type: 'textarea', required: true, wide: true, keep: true},
                  ]}
                  onSubmit={(v) => request('/royalty/manual-accruals', {method: 'POST', body: JSON.stringify({agreementId: a.id, ...v})})}
                  onSaved={reload} />
              )}
            </div>
          );
        }}
      </Tabs>
    </section>
  );
}

export function RoyaltyAgreementsPage({data, onNavigate}) {
  const shell = useShell();
  const request = shell.request;
  const navigate = onNavigate || shell.navigate;
  const selected = shell.getParam('agreement', '');
  const [state, setState] = useState({loading: true});
  const [revision, setRevision] = useState(0);
  const [creating, setCreating] = useState(false);
  const [created, setCreated] = useState('');
  useEffect(() => {
    let live = true;
    setState((previous) => ({...previous, loading: true, error: null}));
    request('/royalty/agreements').then((body) => live && setState({body})).catch((error) => live && setState({error}));
    return () => { live = false; };
  }, [request, revision]);
  const body = state.body;
  const title = 'ロイヤリティ契約';
  const sheets = () => [gridSheetSpec({columns: AGREEMENT_COLUMNS.map((c) => ({...c, hidden: false})), rows: body.agreements, exportSpec: {name: '契約の一覧', title: 'ロイヤリティ契約の一覧'}})];
  return (
    <div className="stack">
      <section className="card rp-report" aria-label={title}>
        <header className="rp-head">
          <div>
            <h2>{title}</h2>
            <p className="rp-muted">監督料・脚本料・音楽著作権料・原作料などの契約です。売上は計上月ごとに発生させ、契約のサイクルで締めた月の報告書にまとめます。条件とサイクルは版で持ち、変えるときは新しい版を足します。</p>
          </div>
          {body && <ReportOutputBar sheets={sheets} name="ロイヤリティ契約の一覧" title={title} formats={['xlsx', 'csv', 'print']} />}
        </header>
        {state.error && <ErrorNotice error={state.error} />}
        {created && <Notice tone="ok" compact message={created} onDismiss={() => setCreated('')}
          actions={<button type="button" className="secondary" onClick={() => navigate('ロイヤリティ作成')}>報告書の作成を開く</button>} />}
        {!shell.readOnly && (creating
          ? <AgreementCreate data={data} expenseCategories={body?.expenseCategories || []} request={request} onCancel={() => setCreating(false)}
            onCreated={(id) => { setCreating(false); setCreated('契約を登録しました。サイクルの締め月を過ぎた期間は「報告書の作成」に並びます。'); setRevision((n) => n + 1); shell.setParam('agreement', String(id), {replace: false}); }} />
          : <div className="ry-actions"><button type="button" onClick={() => setCreating(true)}>＋新規契約</button></div>)}
        {state.loading && !body && <p className="rp-muted" aria-busy="true">読み込み中…</p>}
        {body && (
          <DataGrid columns={AGREEMENT_COLUMNS} rows={body.agreements} rowKey="id" persistKey="royalty-agreements" maxHeight="45vh"
            onRowClick={(row) => shell.setParam('agreement', String(row.id), {replace: false})}
            emptyText="まだ契約がありません。「＋新規契約」から、作品・権利者・条件・サイクルを登録します" />
        )}
        {body?.holders?.some((h) => h.restricted) && <p className="rp-muted">財務権限のない作品の契約は一覧に出していません。</p>}
      </section>
      {selected && <AgreementDetail key={selected} id={selected} expenseCategories={body?.expenseCategories || []} onChanged={() => setRevision((n) => n + 1)} />}
    </div>
  );
}

export default RoyaltyAgreementsPage;
