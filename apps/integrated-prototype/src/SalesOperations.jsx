// 選択中の作品の営業: 営業案件（1つの表で登録・修正・活動の追記）→ 販売契約と条件の版 → 契約版ごとの納品 → 売上報告の関連付け。
// - 段階・流通・状態は labels.mjs の日本語。日付は日本時間、金額は円。ID・ハッシュは主表示に出さない。
// - 期限後に提出した納品は「遅延提出（n日）」、未提出で期限を過ぎたら「納期超過（n日）」（sales-ops/pipeline-routes.mjs）。
// - 提出日・受領日・活動の実施日が今日より後なら、入力中に警告する（保存は止めない）。
// - 売上報告の関連付けは取り消せないので、画面内の2段確認（要約→「この内容で関連付ける／戻って選び直す」）。
import React, {useCallback, useEffect, useId, useMemo, useRef, useState} from 'react';
import {useShell} from './shell/context.mjs';
import {DataGrid} from './ui/DataGrid.jsx';
import {RecordForm} from './ui/RecordForm.jsx';
import {FormField} from './ui/FormField.jsx';
import {Notice} from './ui/Notice.jsx';
import {labelOf, VERBS} from './ui/labels.mjs';
import {yen, int, dateJst, month} from './ui/format.mjs';
import {buildPipeline, deliverableTiming, deliverableFormErrors, futureDateWarnings, termVersionLabel, todayJst} from './sales-ops/pipeline-routes.mjs';
import {territoryOptions, territoryInput, territoryFromInput, resolveTerritory, territoryLabel, OTHER_TERRITORY} from './sales-ops/sales-catalog-model.mjs';
import {PipelineTiles, ToneLabel} from './sales-ops/PipelineBoard.jsx';
import './reports/reports.css';
import './sales-ops/sales-ops.css';

const CHANNEL_OPTIONS = ['digital', 'broadcast', 'theatrical', 'package', 'other'].map((value) => ({value, label: labelOf('channel', value)}));
const termLabel = termVersionLabel;
// サーバーの理由文に残る流通コード（digital 等）を日本語にする
const reasonText = (reason) => String(reason || '').replace(/(販路|種別)([a-z_]+)/g, (match, head, code) => `${head}「${labelOf('reportKind', code)}」`);
const periodText = (term) => (term && (term.license_start || term.license_end) ? `${term.license_start ? dateJst(term.license_start) : '未確認'}〜${term.license_end ? dateJst(term.license_end) : '未確認'}` : null);

// 入力中の内容を外枠の未保存保護に登録する
function useUnsaved(dirty, label) {
  const shell = useShell();
  const id = `so${useId().replace(/:/g, '')}`;
  const register = shell.registerUnsaved;
  useEffect(() => { register?.(id, dirty ? 1 : 0, label); }, [dirty, id, label, register]);
  useEffect(() => () => register?.(id, 0, label), [id, register]); // eslint-disable-line react-hooks/exhaustive-deps
}

function FormError({error}) {
  if (!error) return null;
  return error instanceof Error ? <Notice error={error} /> : <Notice tone="error" message={error.message} />;
}

// ---- 営業案件 ----

const OPPORTUNITY_COLUMNS = [
  {key: 'name', label: '営業案件', type: 'text', sticky: true},
  {key: 'partner_name', label: '取引先', type: 'text'},
  {key: 'stage', label: '段階', type: 'status', domain: 'opportunityStage'},
  {key: 'expected_yen', label: '見込（円）', type: 'yen', total: 'sum'},
  {key: 'close_date', label: '予定日', type: 'date'},
  {key: 'next_action', label: '次の行動', type: 'text', wrap: true, value: (row) => row.next_action || '—'},
  {key: 'next_due_on', label: '次の期限', type: 'date'},
  {key: 'next_state', label: '期限の状況', type: 'text', value: (row) => row.next?.label, render: (row) => <ToneLabel tone={row.next?.tone}>{row.next?.label}</ToneLabel>},
  {key: 'last_activity_on', label: '最終の活動日', type: 'date'},
];

const opportunityFields = (partners) => [
  {name: 'partner_id', label: '取引先', type: 'select', required: true, options: partners.map((partner) => ({value: String(partner.id), label: partner.name}))},
  {name: 'name', label: '案件名', type: 'text', required: true},
  {name: 'stage', label: '段階', type: 'select', domain: 'opportunityStage', required: true, defaultValue: 'lead'},
  {name: 'expected_yen', label: '見込（円）', type: 'yen', hint: '未確認なら空欄のまま登録できます'},
  {name: 'close_date', label: '予定日', type: 'date'},
];

const OPPORTUNITY_EDIT_FIELDS = [
  {name: 'name', label: '案件名', type: 'text', required: true},
  {name: 'stage', label: '段階', type: 'select', domain: 'opportunityStage', required: true},
  {name: 'expected_yen', label: '見込（円）', type: 'yen', hint: '未確認なら空欄'},
  {name: 'close_date', label: '予定日', type: 'date'},
];

function ActivityForm({opportunity, workId, request, readOnly, today, onSaved}) {
  const blank = useMemo(() => ({occurredOn: today, activityType: 'contact', summary: '', nextAction: '', nextDueOn: ''}), [today]);
  const [open, setOpen] = useState(false);
  const [values, setValues] = useState(blank);
  const [errors, setErrors] = useState({});
  const [error, setError] = useState(null);
  const [saving, setSaving] = useState(false);
  const [done, setDone] = useState('');
  const dirty = JSON.stringify(values) !== JSON.stringify(blank);
  useUnsaved(dirty, `「${opportunity.name}」の活動の追記`);
  const warnings = futureDateWarnings(values, today, [['occurredOn', '実施日']]);
  const set = (key) => (value) => { setValues((previous) => ({...previous, [key]: value})); setErrors((previous) => ({...previous, [key]: undefined})); setDone(''); };

  async function submit(event) {
    event.preventDefault();
    if (saving || readOnly) return;
    const found = {};
    if (!values.occurredOn) found.occurredOn = '実施日を入れてください';
    if (!values.summary.trim()) found.summary = '要約を入れてください';
    setErrors(found);
    if (Object.keys(found).length) { setError({message: `${Object.keys(found).length}項目を確認してください`}); return; }
    setSaving(true);
    setError(null);
    try {
      await request('/sales-activities', {method: 'POST', body: JSON.stringify({workId, opportunityId: opportunity.id, occurredOn: values.occurredOn, activityType: values.activityType, summary: values.summary.trim(), nextAction: values.nextAction.trim(), nextDueOn: values.nextDueOn || null})});
      setValues(blank);
      setOpen(false);
      setDone('活動を追記しました。');
      onSaved?.();
    } catch (failure) {
      setError(failure);
    } finally {
      setSaving(false);
    }
  }

  if (readOnly) return null;
  if (!open) {
    return (
      <div className="so-actions">
        <button type="button" className="secondary" onClick={() => setOpen(true)}>＋活動を追記{dirty ? '（入力中）' : ''}</button>
        {done && <Notice tone="ok" compact message={done} onDismiss={() => setDone('')} />}
      </div>
    );
  }
  return (
    <form className="so-form" onSubmit={submit} noValidate aria-label="活動の追記">
      <h4>活動を追記</h4>
      <p className="rp-muted">活動の履歴は追記だけで、あとから修正・削除はできません。次の行動と期限は未確認のまま保存できます。</p>
      <fieldset className="on-form-grid" disabled={saving}>
        <FormField type="date" label="実施日" required value={values.occurredOn} onChange={set('occurredOn')} error={errors.occurredOn} />
        <FormField type="select" label="活動" domain="activityType" includeBlank={false} value={values.activityType} onChange={set('activityType')} />
        <FormField label="要約" required wide value={values.summary} onChange={set('summary')} error={errors.summary} />
        <FormField label="次の行動" value={values.nextAction} onChange={set('nextAction')} />
        <FormField type="date" label="次の期限" value={values.nextDueOn} onChange={set('nextDueOn')} />
      </fieldset>
      {warnings.map((warning) => <Notice key={warning.field} tone="warn" compact message={warning.message} />)}
      <FormError error={error} />
      <div className="on-form-actions">
        <button type="submit" disabled={saving}>{saving ? '保存中…' : '活動を追記'}</button>
        <button type="button" className="secondary" disabled={saving} onClick={() => setOpen(false)}>{VERBS.close}</button>
      </div>
    </form>
  );
}

function OpportunityDetail({row, activities, workId, request, readOnly, today, onChanged}) {
  const history = activities.filter((activity) => activity.opportunity_id === row.id);
  return (
    <div className="so-detail">
      <p className="rp-muted">取引先: {row.partner_name}（取引先を変えるときは新しい営業案件として登録します）</p>
      {!readOnly && (
        <RecordForm mode="edit" collapsible openLabel={VERBS.edit} title="営業案件を修正" fields={OPPORTUNITY_EDIT_FIELDS} submitLabel={VERBS.save}
          initialValues={{name: row.name, stage: row.stage, expected_yen: row.expected_yen, close_date: row.close_date}} successMessage="営業案件を保存しました"
          unsavedLabel={`営業案件「${row.name}」の修正`}
          onSubmit={(values) => request(`/opportunities/${row.id}`, {method: 'PATCH', headers: {'If-Match': String(row.version)},
            body: JSON.stringify({name: values.name, stage: values.stage, expected_yen: values.expected_yen ?? null, close_date: values.close_date ?? null})})}
          onSaved={onChanged} />
      )}
      <h4>活動の履歴（{int(history.length)}件）</h4>
      {history.length ? (
        <ol className="so-timeline">
          {history.map((activity) => (
            <li key={activity.id}>
              <strong>{dateJst(activity.occurred_on)}・{labelOf('activityType', activity.activity_type)}</strong>
              <span>{activity.summary}</span>
              <small>{activity.next_action ? `次の行動: ${activity.next_action}（${activity.next_due_on ? `期限 ${dateJst(activity.next_due_on)}` : '期限未設定'}）` : '次の行動なし'}</small>
            </li>
          ))}
        </ol>
      ) : <p className="rp-muted">活動はまだありません。</p>}
      <ActivityForm opportunity={row} workId={workId} request={request} readOnly={readOnly} today={today} onSaved={onChanged} />
    </div>
  );
}

// ---- 販売契約と条件の版 ----

const TERM_FIELDS = [
  {name: 'versionLabel', label: '版の名称', type: 'text', placeholder: '例: 初版'},
  {name: 'channel', label: '流通', type: 'select', required: true, options: CHANNEL_OPTIONS, defaultValue: 'digital'},
  {name: 'territory', label: '地域', type: 'select', options: territoryOptions(), blankLabel: '未確認', hint: '「国内」「Japan」などは「日本」にそろえて保存します'},
  {name: 'territoryOther', label: '地域（その他）', type: 'text', required: true, visible: (raw) => raw.territory === OTHER_TERRITORY,
    validate: (value) => (String(value ?? '').trim().length > 100 ? '地域は100文字以内で入力してください' : null)},
  {name: 'licenseStart', label: '利用開始日', type: 'date'},
  {name: 'licenseEnd', label: '利用終了日', type: 'date', validate: (value, raw) => (value && raw.licenseStart && value < raw.licenseStart ? '利用終了日は開始日以後にしてください' : null)},
  {name: 'expectedAmountYen', label: '契約見込（円）', type: 'yen', hint: '未確認なら空欄'},
  {name: 'documentReference', label: '文書参照', type: 'text', placeholder: '架空契約書の参照名'},
  {name: 'note', label: '条件メモ', type: 'textarea', wide: true, rows: 2},
];

// 地域の名寄せで理由が返ったとき（100文字を超えるなど）は保存を止める（黙って地域を落とさない）
function territoryOrThrow(input) {
  const resolved = resolveTerritory(input, []);
  if (resolved.error) throw new Error(resolved.error);
  return resolved.territory;
}

function termsPayload(values) {
  const input = territoryFromInput(values.territory, values.territoryOther);
  return {
    documentReference: values.documentReference ?? null, versionLabel: values.versionLabel ?? null, channel: values.channel,
    territory: input ? territoryOrThrow(input) : null, licenseStart: values.licenseStart ?? null, licenseEnd: values.licenseEnd ?? null,
    expectedAmountYen: values.expectedAmountYen ?? null, note: values.note ?? null,
  };
}

function termInitial(term) {
  const territory = territoryInput(term?.territory);
  return {
    versionLabel: term ? '' : '初版', channel: term?.channel || 'digital', territory: territory.select, territoryOther: territory.other,
    licenseStart: term?.license_start || '', licenseEnd: term?.license_end || '', expectedAmountYen: term?.expected_amount_yen ?? '',
    documentReference: term?.document_reference || '', note: term?.note || '',
  };
}

const AGREEMENT_COLUMNS = [
  {key: 'contract_code', label: '契約コード', type: 'code', sticky: true},
  {key: 'title', label: '契約名', type: 'text'},
  {key: 'partner_name', label: '取引先', type: 'text'},
  {key: 'product', label: '商品', type: 'text', value: (row) => row.product_name || '限定しない'},
  {key: 'latest', label: '最新の条件版', type: 'text', value: (row) => termLabel(row.terms.at(-1))},
  {key: 'channel', label: '流通', type: 'text', value: (row) => (row.terms.at(-1) ? labelOf('channel', row.terms.at(-1).channel) : null)},
  {key: 'territory', label: '地域', type: 'text', value: (row) => (row.terms.at(-1)?.territory ? territoryLabel(row.terms.at(-1).territory) : null)},
  {key: 'license', label: '利用期間', type: 'text', value: (row) => periodText(row.terms.at(-1))},
  {key: 'expected', label: '契約見込（円）', type: 'yen', value: (row) => row.terms.at(-1)?.expected_amount_yen ?? null},
];

const TERM_COLUMNS = [
  {key: 'version', label: '版', type: 'text', sticky: true, value: (row) => termLabel(row)},
  {key: 'channel', label: '流通', type: 'status', domain: 'channel'},
  {key: 'territory', label: '地域', type: 'text', value: (row) => (row.territory ? territoryLabel(row.territory) : null)},
  {key: 'license_start', label: '利用開始日', type: 'date'},
  {key: 'license_end', label: '利用終了日', type: 'date'},
  {key: 'expected_amount_yen', label: '見込（円）', type: 'yen', total: 'none'},
  {key: 'document_reference', label: '文書参照', type: 'text', wrap: true},
  {key: 'note', label: '条件メモ', type: 'text', wrap: true},
  {key: 'created_at', label: '登録日時', type: 'datetime'},
];

function AgreementDetail({agreement, request, readOnly, onChanged}) {
  const latest = agreement.terms.at(-1);
  return (
    <div className="so-detail">
      <p className="rp-muted">元の営業案件: {agreement.opportunity_name || '未確認'}・調達ケース: {agreement.intake_label || '関連なし'}。条件の版は追記だけで、前の版と前の版の納品記録は残ります。</p>
      <DataGrid columns={TERM_COLUMNS} rows={[...agreement.terms].reverse()} rowKey="id" showTotals={false} maxHeight="40vh" ariaLabel={`${agreement.contract_code}の条件の版`} />
      {!readOnly && latest && (
        <RecordForm mode="create" collapsible openLabel={`${VERBS.newVersion}（${termLabel(latest)}から）`} title={`第${latest.version_no + 1}版を作る`}
          fields={TERM_FIELDS} initialValues={termInitial(latest)} resetKey={`${agreement.id}:${agreement.version}`} allowContinue={false}
          submitLabel="この内容で新しい版を保存" successMessage="新しい版を保存しました。前の版と前の版の納品記録はそのまま残ります。"
          unsavedLabel={`${agreement.contract_code}の新しい版`}
          onSubmit={(values) => request(`/sales-agreements/${agreement.id}/versions`, {method: 'POST', headers: {'If-Match': String(agreement.version)},
            body: JSON.stringify({sourceVersionId: latest.id, ...termsPayload(values)})})}
          onSaved={onChanged} />
      )}
    </div>
  );
}

// ---- 納品 ----

const DELIVERABLE_COLUMNS = [
  {key: 'title', label: '納品物', type: 'text', sticky: true},
  {key: 'contract_code', label: '契約コード', type: 'code'},
  {key: 'term_label', label: '条件版', type: 'text'},
  {key: 'due_on', label: '期限', type: 'date'},
  {key: 'status', label: '状態', type: 'status', domain: 'deliverableStatus'},
  {key: 'submitted_on', label: '提出日', type: 'date'},
  {key: 'accepted_on', label: '受領日', type: 'date'},
  {key: 'timing', label: '判定', type: 'text', value: (row) => row.timing?.label, render: (row) => <ToneLabel tone={row.timing?.tone}>{row.timing?.label}</ToneLabel>},
  {key: 'note', label: 'メモ', type: 'text', wrap: true, value: (row) => row.note || '—'},
];

function deliverableValues(row, agreements) {
  if (row) {
    return {agreementId: String(row.agreement_id), termVersionId: String(row.term_version_id), title: row.title || '', dueOn: row.due_on || '', status: row.status || 'pending',
      submittedOn: row.submitted_on || '', acceptedOn: row.accepted_on || '', note: row.note || ''};
  }
  const first = agreements[0];
  return {agreementId: first ? String(first.id) : '', termVersionId: first?.terms.at(-1) ? String(first.terms.at(-1).id) : '', title: '', dueOn: '', status: 'pending',
    submittedOn: '', acceptedOn: '', note: ''};
}

function DeliverableForm({mode, row, agreements, workId, request, readOnly, asOf, today, onSaved, onClose}) {
  const initialJson = JSON.stringify(deliverableValues(row, agreements));
  const [values, setValues] = useState(() => JSON.parse(initialJson));
  const [errors, setErrors] = useState({});
  const [error, setError] = useState(null);
  const [saving, setSaving] = useState(false);
  const baseline = useRef(initialJson);
  // 保存済みの内容が変わったときだけ入力を置き換える（別の欄の再読込で入力中の内容を消さない）
  useEffect(() => {
    if (baseline.current === initialJson) return;
    baseline.current = initialJson;
    setValues(JSON.parse(initialJson));
    setErrors({});
    setError(null);
  }, [initialJson]);
  const dirty = JSON.stringify(values) !== baseline.current;
  useUnsaved(dirty, mode === 'edit' ? `納品項目「${row?.title}」の修正` : '納品項目の新規登録');
  const agreement = agreements.find((item) => String(item.id) === values.agreementId);
  const warnings = futureDateWarnings(values, today);
  const timing = deliverableTiming({due_on: values.dueOn || null, submitted_on: values.submittedOn || null, status: values.status}, asOf);

  function set(key) {
    return (value) => {
      setValues((previous) => {
        const next = {...previous, [key]: value};
        if (key === 'agreementId') {
          const chosen = agreements.find((item) => String(item.id) === value);
          next.termVersionId = chosen?.terms.at(-1) ? String(chosen.terms.at(-1).id) : '';
        }
        // 実績日を入れたら状態を合わせる（未提出→提出済み、提出済み→受領済み）
        if (key === 'submittedOn' && value && previous.status === 'pending') next.status = 'submitted';
        if (key === 'acceptedOn' && value && ['pending', 'submitted'].includes(previous.status)) next.status = 'accepted';
        return next;
      });
      setErrors((previous) => ({...previous, [key]: undefined}));
    };
  }

  async function submit(event) {
    event.preventDefault();
    if (saving || readOnly) return;
    const found = deliverableFormErrors(values);
    setErrors(found);
    if (Object.keys(found).length) { setError({message: `${Object.keys(found).length}項目を確認してください`}); return; }
    setSaving(true);
    setError(null);
    const payload = {workId, agreementId: Number(values.agreementId), termVersionId: Number(values.termVersionId), title: values.title.trim(), dueOn: values.dueOn,
      status: values.status, submittedOn: values.submittedOn, acceptedOn: values.acceptedOn, note: values.note};
    try {
      if (mode === 'edit') await request(`/deliverables/${row.id}`, {method: 'PATCH', headers: {'If-Match': String(row.version)}, body: JSON.stringify(payload)});
      else await request('/deliverables', {method: 'POST', body: JSON.stringify(payload)});
      baseline.current = JSON.stringify(values);
      onSaved?.(mode === 'edit' ? `納品項目「${values.title.trim()}」を保存しました` : `納品項目「${values.title.trim()}」を登録しました`);
    } catch (failure) {
      setError(failure);
    } finally {
      setSaving(false);
    }
  }

  const termOptions = (agreement?.terms || []).map((term) => ({value: String(term.id), label: termLabel(term)}));
  return (
    <form className="so-form" onSubmit={submit} noValidate aria-label={mode === 'edit' ? '納品項目の修正' : '納品項目の新規登録'}>
      <h4>{mode === 'edit' ? '納品項目を修正' : '納品項目の新規登録'}</h4>
      <fieldset className="on-form-grid" disabled={saving || readOnly}>
        {mode === 'edit' ? (
          <p className="rp-muted on-field-wide">契約: {agreement ? `${agreement.contract_code}｜${agreement.title}` : '未確認'}・条件版: {termLabel(agreement?.terms.find((term) => String(term.id) === values.termVersionId)) || '未確認'}</p>
        ) : (
          <>
            <FormField type="select" label="契約" required value={values.agreementId} onChange={set('agreementId')} error={errors.agreementId}
              options={agreements.map((item) => ({value: String(item.id), label: `${item.contract_code}｜${item.title}`}))} />
            <FormField type="select" label="条件版" required value={values.termVersionId} onChange={set('termVersionId')} error={errors.termVersionId} options={termOptions}
              hint="既定は最新の版です" />
          </>
        )}
        <FormField label="納品物" required value={values.title} onChange={set('title')} error={errors.title} placeholder="例: 本編マスター" />
        <FormField type="date" label="期限" value={values.dueOn} onChange={set('dueOn')} />
        <FormField type="select" label="状態" domain="deliverableStatus" includeBlank={false} value={values.status} onChange={set('status')} />
        <FormField type="date" label="提出日" value={values.submittedOn} onChange={set('submittedOn')} error={errors.submittedOn} hint="実際に提出した日" />
        <FormField type="date" label="受領日" value={values.acceptedOn} onChange={set('acceptedOn')} error={errors.acceptedOn} hint="先方が受け取った日" />
        <FormField label="メモ" wide value={values.note} onChange={set('note')} />
      </fieldset>
      {warnings.map((warning) => <Notice key={warning.field} tone="warn" compact message={warning.message} />)}
      <p className="rp-muted">{dateJst(asOf)}時点の判定: <ToneLabel tone={timing.tone}>{timing.label}</ToneLabel></p>
      <FormError error={error} />
      <div className="on-form-actions">
        <button type="submit" disabled={saving || readOnly}>{saving ? '保存中…' : mode === 'edit' ? VERBS.save : VERBS.register}</button>
        {mode === 'edit'
          ? dirty && <button type="button" className="secondary" disabled={saving} onClick={() => { setValues(JSON.parse(baseline.current)); setErrors({}); setError(null); }}>変更を戻す</button>
          : <button type="button" className="secondary" disabled={saving} onClick={onClose}>{VERBS.close}</button>}
      </div>
    </form>
  );
}

// ---- 売上報告の関連付け ----

function ReportLinks({body, workId, asOf, partners, request, readOnly, onChanged}) {
  const [termId, setTermId] = useState('');
  const [candidates, setCandidates] = useState({rows: []});
  const [confirm, setConfirm] = useState(null);
  const [notice, setNotice] = useState(null);
  const [saving, setSaving] = useState(false);
  const ticket = useRef(0);
  const partnerName = (id) => partners.find((partner) => partner.id === id)?.name || '未確認';
  const allTerms = useMemo(() => body.agreements.flatMap((agreement) => agreement.terms.map((term) => ({...term, agreement}))), [body]);
  const currentTerms = allTerms.filter((term) => term.version_no === term.agreement.terms.at(-1)?.version_no);
  const termText = (term) => (term ? `${term.agreement.contract_code}・${termLabel(term)}・${labelOf('channel', term.channel)}` : '未確認');

  async function choose(value) {
    setTermId(value);
    setConfirm(null);
    setNotice(null);
    const id = ++ticket.current;
    if (!value) { setCandidates({rows: []}); return; }
    setCandidates({rows: [], loading: true});
    try {
      const result = await request(`/sales-operations?workId=${workId}&asOf=${asOf}&termVersionId=${value}`);
      if (id === ticket.current) setCandidates({rows: result.candidateReports || []});
    } catch (error) {
      if (id === ticket.current) setCandidates({rows: [], error});
    }
  }

  async function link() {
    if (!confirm || saving || readOnly) return;
    setSaving(true);
    try {
      await request('/sales-report-links', {method: 'POST', body: JSON.stringify({workId, reportId: confirm.id, agreementTermVersionId: Number(termId)})});
      setNotice({tone: 'ok', message: `「${confirm.report_key}」を ${termText(allTerms.find((term) => String(term.id) === termId))} へ関連付けました。元の売上・金額・計上月は変えていません。`});
      setConfirm(null);
      onChanged?.();
      await choose(termId);
    } catch (error) {
      setNotice({error});
    } finally {
      setSaving(false);
    }
  }

  const linkColumns = [
    {key: 'report_key', label: '売上報告', type: 'code', sticky: true},
    {key: 'kind', label: '種類', type: 'status', domain: 'reportKind'},
    {key: 'accounting_month', label: '計上月', type: 'month'},
    {key: 'term', label: '関連付けた条件版', type: 'text', value: (row) => termText(allTerms.find((term) => term.id === row.term_version_id))},
    {key: 'review', label: '確認', type: 'text', value: (row) => (row.needsReview ? '契約に新しい版あり・要確認' : '関連付けた時点の最新版'),
      render: (row) => (row.needsReview ? <ToneLabel tone="warn">契約に新しい版あり・要確認</ToneLabel> : <ToneLabel tone="ok">関連付けた時点の最新版</ToneLabel>)},
  ];

  return (
    <section className="card so-section" aria-label="売上報告の関連付け">
      <header className="so-head">
        <div>
          <h2>売上報告を契約の根拠へ関連付ける</h2>
          <p className="rp-muted">最新の条件版へ、登録済みの売上報告を説明のために関連付けます。元の報告・売上・金額・計上月は変わりません。関連付けはあとから外せません。</p>
        </div>
      </header>
      {!readOnly && (
        <FormField type="select" label="関連付ける条件版（最新の版だけ）" value={termId} onChange={choose} blankLabel="選択してください"
          options={currentTerms.map((term) => ({value: String(term.id), label: termText(term)}))} hint={currentTerms.length ? undefined : '先に販売契約を登録してください'} />
      )}
      {candidates.loading && <p className="rp-muted" aria-busy="true">候補を読み込み中…</p>}
      {candidates.error && <Notice error={candidates.error} onRetry={() => choose(termId)} />}
      {termId && !candidates.loading && !candidates.error && (
        candidates.rows.length ? (
          <ul className="so-candidates">
            {candidates.rows.map((report) => (
              <li key={report.id} className={report.eligible ? undefined : 'is-disabled'}>
                <div>
                  <strong>{report.report_key}・{labelOf('reportKind', report.kind)}</strong>
                  <small>取引先 {partnerName(report.partner_id)}・計上月 {month(report.accounting_month)}・この作品への配賦 {yen(report.allocatedAmountExTax)}</small>
                  {report.reason && <small>{reasonText(report.reason)}</small>}
                </div>
                <button type="button" className="secondary" disabled={!report.eligible || saving} onClick={() => { setConfirm(report); setNotice(null); }}>この条件版へ関連付ける</button>
              </li>
            ))}
          </ul>
        ) : <p className="rp-muted">関連付けられる売上報告はありません。</p>
      )}
      {confirm && (
        <div className="so-confirm" role="group" aria-label="関連付けの確認">
          <p><strong>次の内容で関連付けます（あとから外せません）</strong></p>
          <p>売上報告「{confirm.report_key}」（{labelOf('reportKind', confirm.kind)}・{partnerName(confirm.partner_id)}・計上月 {month(confirm.accounting_month)}・この作品への配賦 {yen(confirm.allocatedAmountExTax)}）</p>
          <p>→ {termText(allTerms.find((term) => String(term.id) === termId))}</p>
          <div className="so-actions">
            <button type="button" disabled={saving} onClick={link}>{saving ? '関連付け中…' : 'この内容で関連付ける'}</button>
            <button type="button" className="secondary" disabled={saving} onClick={() => setConfirm(null)}>戻って選び直す</button>
          </div>
        </div>
      )}
      {notice && <Notice tone={notice.tone} message={notice.message} error={notice.error} onDismiss={() => setNotice(null)} />}
      <DataGrid columns={linkColumns} rows={body.reportLinks} rowKey={(row) => `${row.work_id}-${row.report_id}`} showTotals={false}
        emptyText="関連付けた売上報告はまだありません。" ariaLabel="関連付けた売上報告" />
    </section>
  );
}

// ---- 画面 ----

export default function SalesOperations({data, request: requestProp, onOpportunityChanged}) {
  const shell = useShell();
  const requestRef = useRef(null);
  requestRef.current = requestProp || shell.request;
  const request = useCallback((path, options) => requestRef.current(path, options), []);
  const readOnly = Boolean(shell.readOnly);
  const workId = data.selectedWorkId;
  const work = data.selectedWork || data.works?.find((item) => item.id === workId);
  const today = todayJst();
  const asOf = shell.getParam('asOf', today) || today;
  const [state, setState] = useState({loading: true, workId});
  const [intakes, setIntakes] = useState([]);
  const [revision, setRevision] = useState(0);
  const [creatingDeliverable, setCreatingDeliverable] = useState(false);
  const [notices, setNotices] = useState({});
  const reload = useCallback(() => setRevision((n) => n + 1), []);
  const say = (section, notice) => setNotices((previous) => ({...previous, [section]: notice}));

  useEffect(() => {
    let live = true;
    setState((previous) => (previous.workId === workId ? {...previous, loading: true, error: null} : {loading: true, workId}));
    if (!workId) { setState({loading: false, workId}); return undefined; }
    Promise.all([
      request(`/sales-operations?workId=${workId}&asOf=${asOf}`),
      request(`/intakes?workId=${workId}`).catch(() => ({cases: []})),
    ]).then(([body, intake]) => {
      if (!live) return;
      setState({body, workId});
      setIntakes(intake?.cases || []);
    }).catch((error) => { if (live) setState({error, workId}); });
    return () => { live = false; };
  }, [workId, asOf, revision, request]);

  const partners = data.partners || [];
  const body = state.workId === workId ? state.body : null;
  const partnerName = useCallback((id) => partners.find((partner) => partner.id === id)?.name || '未確認', [partners]);
  const built = useMemo(() => (body ? buildPipeline({
    works: [{id: workId, title: work?.title}],
    opportunities: body.opportunities.map((row) => ({...row, partner_name: partnerName(row.partner_id)})),
    activities: body.activities, agreements: body.agreements, terms: body.terms, deliverables: body.deliverables, asOf,
  }) : null), [body, workId, work?.title, partnerName, asOf]);
  const agreements = useMemo(() => (body?.agreements || []).map((agreement) => {
    const opportunity = body.opportunities.find((row) => row.id === agreement.opportunity_id);
    const intake = intakes.find((row) => row.id === agreement.intake_case_id);
    return {...agreement, opportunity_name: opportunity?.name, intake_label: intake ? `${intake.case_code}｜${intake.title}` : null};
  }), [body, intakes]);
  const linkedProductIds = new Set((data.productAllocations || []).filter((row) => row.work_id === workId).map((row) => row.product_id));
  const products = (data.products || []).filter((row) => linkedProductIds.has(row.id));

  const oppParam = shell.getParam('opp', null);
  const deliverableParam = shell.getParam('deliverable', null);
  const oppExpand = useMemo(() => (oppParam && body ? {key: String(oppParam), nonce: `${oppParam}:${workId}`} : undefined), [oppParam, body, workId]);
  const deliverableExpand = useMemo(() => (deliverableParam && body ? {key: String(deliverableParam), nonce: `${deliverableParam}:${workId}`} : undefined), [deliverableParam, body, workId]);

  if (!workId) return <section className="card"><p className="rp-muted">作品を選ぶと、その作品の営業が表示されます。</p></section>;
  if (state.error && !body) return <section className="card"><Notice error={state.error} onRetry={reload} /></section>;
  if (!body || !built) return <section className="card"><p className="rp-muted" aria-busy="true">営業の情報を読み込んでいます…</p></section>;

  const exportConditions = [['作品', work?.title || '未確認'], ['判定日', dateJst(asOf)]];
  const agreementFields = [
    {name: 'opportunityId', label: '元の営業案件', type: 'select', required: true, options: built.opportunities.map((row) => ({value: String(row.id), label: `${row.name}（${row.partner_name}）`}))},
    {name: 'contractCode', label: '契約コード', type: 'text', required: true, hint: '登録後は変えられません'},
    {name: 'title', label: '契約名', type: 'text', required: true},
    {name: 'productId', label: '商品', type: 'select', blankLabel: '商品を限定しない', options: products.map((row) => ({value: String(row.id), label: `${row.sku}｜${row.name}`}))},
    {name: 'intakeCaseId', label: '調達ケース', type: 'select', blankLabel: '関連なし・未確認', options: intakes.map((row) => ({value: String(row.id), label: `${row.case_code}｜${row.title}`}))},
    ...TERM_FIELDS,
  ];

  return (
    <div className="so-page sales-operations">
      <section className="card rp-report" aria-label="営業の集計">
        <header className="so-head">
          <div>
            <h2>{work?.title || '選択中の作品'}の営業</h2>
            <p className="rp-muted">{body.scopeNote}</p>
          </div>
          <div className="so-actions">
            <FormField type="date" label="期限の判定日" value={asOf} onChange={(value) => shell.setParam('asOf', value && value !== today ? value : null, {replace: true})} />
            <button type="button" className="secondary" onClick={() => shell.setParam('view', 'pipeline')}>全作品のパイプラインを見る</button>
          </div>
        </header>
        {state.error && <Notice error={state.error} onRetry={reload} />}
        <PipelineTiles summary={built.summary}>
          <div role="listitem">
            <span>契約条件の見込（各契約の最新版）</span>
            <strong>{yen(body.summary.agreementExpectedYen)}</strong>
            <small>商談見込とは別の数字{body.summary.unknownAgreementAmountCount ? `・見込未入力 ${int(body.summary.unknownAgreementAmountCount)}件は含まない` : ''}</small>
          </div>
        </PipelineTiles>
      </section>

      <section className="card so-section" aria-label="営業案件">
        <header className="so-head">
          <div>
            <h2>営業案件（{int(built.opportunities.length)}件）</h2>
            <p className="rp-muted">行を押すと、修正・活動の履歴・次の行動の追記が開きます。</p>
          </div>
        </header>
        <RecordForm openLabel="＋営業案件を登録" title="営業案件の新規登録" fields={opportunityFields(partners)} allowContinue={false} resetKey={workId}
          successMessage="営業案件を登録しました" unsavedLabel="営業案件の新規登録"
          onSubmit={(values) => request('/opportunities', {method: 'POST', body: JSON.stringify({project_id: work?.project_id, work_id: workId, partner_id: Number(values.partner_id),
            name: values.name, stage: values.stage, expected_yen: values.expected_yen ?? null, close_date: values.close_date ?? null})})}
          onSaved={() => { reload(); onOpportunityChanged?.(); }} />
        <DataGrid columns={OPPORTUNITY_COLUMNS} rows={built.opportunities} rowKey="id" persistKey="sales-ops-opportunities" expandRequest={oppExpand}
          emptyText="営業案件はまだありません。「＋営業案件を登録」から登録します。" initialSort={{key: 'next_due_on', dir: 'asc'}}
          exportSpec={{name: `営業案件_${work?.title || '作品'}`, title: `営業案件（${work?.title || '作品'}）`, conditions: exportConditions, dataAsOf: dateJst(today),
            notes: ['見込が未入力の案件は金額の合計に含めていません。']}}
          renderDetail={(row) => <OpportunityDetail row={row} activities={body.activities} workId={workId} request={request} readOnly={readOnly} today={today} onChanged={reload} />} />
      </section>

      <section className="card so-section" aria-label="販売契約と条件の版">
        <header className="so-head">
          <div>
            <h2>販売契約と条件の版（{int(agreements.length)}件）</h2>
            <p className="rp-muted">受注から契約・売上は自動で作りません。文書参照は説明のための情報で、法的な有効性は判定しません。行を押すと版の履歴と「{VERBS.newVersion}」が開きます。</p>
          </div>
        </header>
        {built.opportunities.length
          ? <RecordForm openLabel="＋販売契約を登録" title="販売契約と初版の条件" fields={agreementFields} allowContinue={false} resetKey={workId}
              initialValues={termInitial(null)} submitLabel="契約と初版の条件を登録" successMessage="販売契約と初版の条件を登録しました" unsavedLabel="販売契約の新規登録"
              onSubmit={(values) => request('/sales-agreements', {method: 'POST', body: JSON.stringify({workId, opportunityId: Number(values.opportunityId),
                productId: values.productId ? Number(values.productId) : null, intakeCaseId: values.intakeCaseId ? Number(values.intakeCaseId) : null,
                contractCode: values.contractCode, title: values.title, terms: termsPayload(values)})})}
              onSaved={reload} />
          : <p className="rp-muted">先に営業案件を登録すると、販売契約を登録できます。</p>}
        <DataGrid columns={AGREEMENT_COLUMNS} rows={agreements} rowKey="id" persistKey="sales-ops-agreements"
          emptyText="販売契約はまだありません。"
          exportSpec={{name: `販売契約_${work?.title || '作品'}`, title: `販売契約（${work?.title || '作品'}・各契約の最新版）`, conditions: exportConditions, dataAsOf: dateJst(today)}}
          renderDetail={(row) => <AgreementDetail agreement={row} request={request} readOnly={readOnly} onChanged={reload} />} />
      </section>

      <section className="card so-section" aria-label="契約版ごとの納品">
        <header className="so-head">
          <div>
            <h2>契約版ごとの納品（{int(built.deliverables.length)}件）</h2>
            <p className="rp-muted">提出日・受領日は起きた日を入れます。期限後に提出した納品は「遅延提出（n日）」として数えます。契約を改訂しても前の版の納品記録は残ります。</p>
          </div>
          {!readOnly && !creatingDeliverable && agreements.length > 0 && (
            <button type="button" onClick={() => { setCreatingDeliverable(true); say('deliverables', null); }}>＋納品項目を登録</button>
          )}
        </header>
        {!agreements.length && <p className="rp-muted">先に販売契約を登録すると、納品項目を登録できます。</p>}
        {creatingDeliverable && (
          <DeliverableForm mode="create" agreements={agreements} workId={workId} request={request} readOnly={readOnly} asOf={asOf} today={today}
            onClose={() => setCreatingDeliverable(false)}
            onSaved={(message) => { setCreatingDeliverable(false); say('deliverables', {tone: 'ok', message}); reload(); }} />
        )}
        {notices.deliverables && <Notice tone={notices.deliverables.tone} message={notices.deliverables.message} compact onDismiss={() => say('deliverables', null)} />}
        <DataGrid columns={DELIVERABLE_COLUMNS} rows={built.deliverables} rowKey="id" persistKey="sales-ops-deliverables" expandRequest={deliverableExpand}
          emptyText="納品項目はまだありません。" initialSort={{key: 'due_on', dir: 'asc'}}
          exportSpec={{name: `納品_${work?.title || '作品'}`, title: `契約版ごとの納品（${work?.title || '作品'}）`, conditions: exportConditions, dataAsOf: dateJst(today),
            notes: ['判定: 提出日が期限より後の納品は「遅延提出（n日）」、未提出で期限を過ぎた納品は「納期超過（n日）」。']}}
          renderDetail={(row) => (
            <div className="so-detail">
              <DeliverableForm mode="edit" row={row} agreements={agreements} workId={workId} request={request} readOnly={readOnly} asOf={asOf} today={today}
                onSaved={(message) => { say('deliverables', {tone: 'ok', message}); reload(); }} />
            </div>
          )} />
      </section>

      <ReportLinks body={body} workId={workId} asOf={asOf} partners={partners} request={request} readOnly={readOnly} onChanged={reload} />

      <details className="card">
        <summary>制作準備の参照（参照のみ・{int(body.fieldReadiness.shootingDayCount)}撮影日）</summary>
        <p className="rp-muted">{body.fieldReadiness.note}</p>
        <div className="rp-tiles" role="list" aria-label="制作準備">
          <div role="listitem"><span>撮影日</span><strong>{int(body.fieldReadiness.shootingDayCount)}日</strong></div>
          <div role="listitem"><span>撮影済みの割当</span><strong>{int(body.fieldReadiness.shotAssignments)}件</strong></div>
          <div role="listitem"><span>一部撮影</span><strong>{int(body.fieldReadiness.partialAssignments)}件</strong></div>
          <div role="listitem"><span>準備中・保留</span><strong>{int(body.fieldReadiness.pendingPrep + body.fieldReadiness.blockedPrep)}件</strong></div>
        </div>
      </details>
    </div>
  );
}
