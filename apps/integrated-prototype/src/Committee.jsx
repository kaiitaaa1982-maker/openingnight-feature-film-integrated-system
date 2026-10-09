// 製作委員会。窓口・幹事・出資者への分配を契約条件から試算し、根拠つきの期間報告を版として保存する。
// 並び: 保存済みの期間報告（上）→ 期間報告の作成（前回の条件版・次の締め期間・前回の基準が既定値）→ 契約条件の一覧（登録は折りたたみ）。
// 契約条件の入力は「基本 → 出資 → 窓口 → 控除 → 日程」の段落。新しい版は押した版のすぐ下に開く。
// 共同製作・入金基準の契約がある作品は、タブで切り替え、契約を選べる。
import React, {useEffect, useId, useMemo, useRef, useState} from 'react';
import {useShell} from './shell/context.mjs';
import {Tabs} from './ui/Tabs.jsx';
import {DataGrid} from './ui/DataGrid.jsx';
import {Notice} from './ui/Notice.jsx';
import {FormField} from './ui/FormField.jsx';
import {yen, int, dateJst, month as monthText} from './ui/format.mjs';
import {FundingFields, DeductionFields, PercentField, DayField, ProblemNotice} from './CommitteeFinanceFields.jsx';
import JointCommittee from './JointCommittee.jsx';
import {
  SCREEN_TEXT, COMMITTEE_FLOW, WINDOW_KIND_OPTIONS, ROUTE_OPTIONS, FEE_ORDER_OPTIONS, REFERENCE_TYPE_OPTIONS, REPORT_BASIS_OPTIONS,
  PERIOD_DATE_BASIS_OPTIONS, windowKindText, routeText, feeBasisText, feeOrderText, reportBasisText, periodDateBasisText, referenceTypeText,
  percentText, intervalText, dayText, offsetText, latestVersion, translateError, japaneseMessage,
} from './rights/rights-ui-model.mjs';
import {
  windowBasisOptions, applyWindowRules, blankWindow, windowWithKind, blankPhase, samplePhases, newTermsForm, termsFormFromVersion, copyTermsInto,
  membersOfIntake, validateTermsForm, termsPayload, windowSummary, builderDefaults, nextPeriodIndex, basisByKind, snapshotRows, deductionPayload,
} from './rights/committee-ui-model.mjs';
import './reports/reports.css';
import './RightsReports.css';

const T = SCREEN_TEXT.committee;
const SECTION_TITLES = {basic: '基本', funding: '出資', windows: '窓口', deductions: '控除', schedule: '日程'};

function printReport(id) {
  const target = document.getElementById(id);
  if (!target) return;
  target.classList.add('print-target');
  const cleanup = () => { target.classList.remove('print-target'); window.removeEventListener('afterprint', cleanup); };
  window.addEventListener('afterprint', cleanup);
  window.print();
}

function useUnsaved(dirty, label) {
  const shell = useShell();
  const id = `committee${useId().replace(/:/g, '')}`;
  const register = shell?.registerUnsaved;
  useEffect(() => { register?.(id, dirty ? 1 : 0, label); }, [dirty, id, label, register]);
  useEffect(() => () => register?.(id, 0, label), [id, register]); // eslint-disable-line react-hooks/exhaustive-deps
}

function SectionErrors({errors, section}) {
  const list = errors.filter((item) => item.section === section);
  if (!list.length) return null;
  return <Notice tone="error" compact title={`${SECTION_TITLES[section]}で${list.length}か所を確認してください`}><ul className="rt-errors">{list.map((item) => <li key={item.message}>{item.message}</li>)}</ul></Notice>;
}

// ---- 契約条件の入力（新規・新しい版） ----

function TermsForm({work, contracts, intakes, source, request, readOnly, onSaved, onClose}) {
  const initial = useMemo(() => (source ? termsFormFromVersion(source.contract, source.version) : newTermsForm({work, contracts})), [source?.version?.id, work?.id]); // eslint-disable-line react-hooks/exhaustive-deps
  const [form, setForm] = useState(initial);
  const [errors, setErrors] = useState([]);
  const [error, setError] = useState(null);
  const [saving, setSaving] = useState(false);
  const [copyFrom, setCopyFrom] = useState('');
  const [retroactive, setRetroactive] = useState(null);
  const baseline = useRef(JSON.stringify(initial));
  useEffect(() => { setForm(initial); baseline.current = JSON.stringify(initial); setErrors([]); }, [initial]);
  const dirty = JSON.stringify(form) !== baseline.current;
  useUnsaved(dirty, source ? '委員会の条件の新しい版' : '委員会の契約条件の登録');
  const disabled = readOnly || saving;

  const intake = intakes.find((row) => String(row.id) === String(form.intakeCaseId)) || (source ? intakes.find((row) => row.id === source.contract.intake_case_id) : null);
  const members = source && !intake
    ? (source.version.members || []).map((row) => ({partnerId: row.partner_id, partnerName: row.partner_name, shareBps: row.share_bps, role: row.role}))
    : membersOfIntake(intake);
  const memberOptions = members.map((row) => ({value: String(row.partnerId), label: row.partnerName}));
  const documents = intake?.documents || [];
  const validDocuments = documents.filter((row) => row.title && row.reference && row.version_label);
  const copyOptions = contracts.map((contract) => {
    const version = latestVersion(contract.versions);
    return version ? {value: String(version.id), label: `${contract.contract_code}｜${contract.title}（版${version.version_no}）`} : null;
  }).filter(Boolean);

  const setWindow = (index, next) => setForm((current) => ({...current, windows: current.windows.map((row, i) => (i === index ? applyWindowRules(next, current.managerPartnerId) : row))}));
  const setPhase = (index, key, value) => setForm((current) => ({...current, phases: current.phases.map((row, i) => (i === index ? {...row, [key]: value} : row))}));

  function chooseIntake(value) {
    const selected = intakes.find((row) => String(row.id) === String(value));
    const docs = (selected?.documents || []).filter((row) => row.title && row.reference && row.version_label);
    const nextMembers = membersOfIntake(selected);
    setForm((current) => ({...current, intakeCaseId: value, documentId: docs.length === 1 ? String(docs[0].id) : '', managerPartnerId: '', funding: null,
      windows: [blankWindow({members: nextMembers, managerPartnerId: ''})]}));
    setCopyFrom('');
  }

  function chooseManager(value) {
    setForm((current) => ({...current, managerPartnerId: value, windows: current.windows.map((row) => applyWindowRules(row, value))}));
  }

  function copyTerms(versionId) {
    setCopyFrom(versionId);
    const version = contracts.flatMap((contract) => contract.versions).find((row) => String(row.id) === String(versionId));
    if (version) setForm((current) => copyTermsInto(current, version, members));
  }

  async function save(event) {
    event.preventDefault();
    if (disabled) return;
    setError(null);
    const checked = validateTermsForm(form, {members, isNew: !source});
    setErrors(checked.errors);
    if (!checked.ok) return;
    setSaving(true);
    try {
      const payload = termsPayload({...form, confirmRetroactive: retroactive?.confirmed === true}, work.id);
      const saved = await request(source ? `/committee/contracts/${form.contractId}/versions` : '/committee/contracts', {method: 'POST', body: JSON.stringify(payload)});
      baseline.current = JSON.stringify(form);
      const skipped = (saved?.feeShares?.skipped || []).map((row) => `${row.label}: ${row.reason}`);
      const effective = saved?.effectiveFrom ? `${monthText(saved.effectiveFrom)}から適用` : '最初の月から適用';
      onSaved(source
        ? `「${form.contractCode}」の新しい版を保存しました（${effective}。前の版と保存済みの報告は変わりません）${skipped.length ? `。窓口手数料の取り分を引き継いでいない窓口があります（${skipped.join('／')}）。月次収支の画面で登録してください` : ''}`
        : `委員会の契約「${form.contractCode}」と版1を登録しました`);
    } catch (cause) {
      // 確定済みのロイヤリティ報告書の計上月を変える版は、影響する報告書を示して確認を取る
      if (cause?.status === 409 && cause?.details?.code === 'retroactive') setRetroactive({message: cause.message, statements: cause.details.affectedStatements || [], confirmed: false});
      else setError(translateError(cause));
    } finally {
      setSaving(false);
    }
  }

  const notReady = intakes.filter((row) => !row.committeeContractReady);
  return (
    <form className="rt-form" onSubmit={save} noValidate aria-label={source ? '委員会の条件の新しい版' : '委員会の契約条件の登録'}>
      <fieldset className="rt-section" disabled={disabled}>
        <legend><span className="rt-step">1</span>基本</legend>
        {source
          ? (
            <>
              <p className="rt-muted">調達案件「{source.contract.intake_case_code}」と契約書「{source.contract.document_title}」を引き継ぎます。前の版と保存済みの報告は変わりません。</p>
              <div className="on-form-grid">
                <FormField type="month" label="適用開始月（計上月）" value={form.effectiveFrom || ''}
                  hint="この月から後の計上月だけを新しい版で計算し、前の月は前の版のままです。空欄にすると最初の月から前の版に代わります（過去の月の訂正）"
                  onChange={(value) => { setForm({...form, effectiveFrom: value}); setRetroactive(null); }} />
                <label className="check">
                  <input type="checkbox" checked={form.copyFeeShares !== false} onChange={(event) => setForm({...form, copyFeeShares: event.target.checked})} />
                  <span>コピー元の版の窓口手数料の取り分を引き継ぐ（窓口の受取先が同じ窓口だけ。取り分を変えるときは外して、保存後に月次収支の画面で登録）</span>
                </label>
              </div>
            </>
          )
          : (
            <>
              <div className="on-form-grid">
                <FormField type="select" label="製作委員会の調達案件" required value={form.intakeCaseId} blankLabel={intakes.length ? '選んでください' : '製作委員会の調達案件がありません'}
                  options={intakes.filter((row) => row.committeeContractReady).map((row) => ({value: String(row.id), label: `${row.case_code}｜${row.title}`}))} onChange={chooseIntake} />
                <FormField type="select" label="契約書の参照" required value={form.documentId} disabled={!intake}
                  options={documents.map((row) => ({value: String(row.id), label: `${row.title || '名称未確認'}｜${row.version_label || '版未確認'}`}))}
                  hint={intake && !validDocuments.length ? '名称・参照先・版がそろった契約書がありません' : undefined} onChange={(value) => setForm({...form, documentId: value})} />
                <FormField label="契約コード" required value={form.contractCode} hint="作品コードと連番で自動で入れています" onChange={(value) => setForm({...form, contractCode: value})} />
                <FormField label="契約名" required value={form.title} onChange={(value) => setForm({...form, title: value})} />
              </div>
              {notReady.length > 0 && (
                <p className="rt-muted">
                  選べない調達案件が{notReady.length}件あります（{notReady.map((row) => `${row.case_code}：${(row.committeeContractMissing || []).join('、')}`).join('／')}）。
                  「調達・権利」で改訂版を作り、契約書の参照・参加者・役割・持分の合計100%を補ってください。
                </p>
              )}
              {copyOptions.length > 0 && (
                <div className="on-form-grid">
                  <FormField type="select" label="既存の契約の条件を写す（任意）" value={copyFrom} disabled={!members.length} blankLabel={members.length ? '写さない' : '先に調達案件を選んでください'}
                    options={copyOptions} hint="窓口・手数料・日程を写します。出資者にいない窓口担当は空に戻します" onChange={copyTerms} />
                </div>
              )}
            </>
          )}
        <div className="on-form-grid">
          <FormField type="select" label="幹事" value={form.managerPartnerId} options={memberOptions} blankLabel="幹事なし" disabled={!members.length}
            hint="幹事なしのときは、窓口から出資者へ直接・幹事手数料0%になります" onChange={chooseManager} />
        </div>
        <SectionErrors errors={errors} section="basic" />
      </fieldset>

      <fieldset className="rt-section" disabled={disabled}>
        <legend><span className="rt-step">2</span>出資</legend>
        {members.length
          ? <div className="rt-chips">{members.map((row) => <span className="rt-chip" key={row.partnerId}>{row.partnerName}｜{row.role || '役割未確認'}｜持分 {percentText(row.shareBps)}</span>)}</div>
          : <p className="rt-muted">調達案件を選ぶと、出資者と持分が表示されます。</p>}
        <FundingFields value={form.funding} members={members} disabled={disabled} onChange={(funding) => setForm((current) => ({...current, funding}))} />
        <SectionErrors errors={errors} section="funding" />
      </fieldset>

      <fieldset className="rt-section" disabled={disabled}>
        <legend><span className="rt-step">3</span>窓口（販路ごと）</legend>
        {form.windows.map((row, index) => (
          <div className="rt-row" key={index}>
            <div className="rt-row-head">
              <span>窓口{index + 1}{row.kind ? `（${windowKindText(row.kind)}）` : ''}</span>
              {form.windows.length > 1 && <button type="button" className="text" onClick={() => setForm((current) => ({...current, windows: current.windows.filter((_, i) => i !== index)}))}>この窓口を外す</button>}
            </div>
            <div className="on-form-grid">
              <FormField type="select" label="販路" required value={row.kind} options={WINDOW_KIND_OPTIONS} onChange={(value) => setWindow(index, windowWithKind(row, value))} />
              <FormField label="表示名" required value={row.label} placeholder="例: 配信窓口" onChange={(value) => setWindow(index, {...row, label: value})} />
              <FormField type="select" label="窓口担当" required value={row.windowPartnerId} options={memberOptions} blankLabel="出資者から選ぶ" onChange={(value) => setWindow(index, {...row, windowPartnerId: value})} />
              <FormField type="select" label="分配の経路" required value={row.route} options={form.managerPartnerId ? ROUTE_OPTIONS : ROUTE_OPTIONS.filter((item) => item.value === 'direct')}
                onChange={(value) => setWindow(index, {...row, route: value})} />
              <PercentField label="PF料率" required value={row.platformRate} onChange={(value) => setWindow(index, {...row, platformRate: value})} />
            </div>
          </div>
        ))}
        <div className="rt-actions">
          <button type="button" className="secondary" disabled={form.windows.length >= 5}
            onClick={() => setForm((current) => ({...current, windows: [...current.windows, blankWindow({members, managerPartnerId: current.managerPartnerId})]}))}>窓口を追加</button>
          <span className="rt-muted">販路ごとに1件（同じ販路は重ねられません）。</span>
        </div>
        <SectionErrors errors={errors} section="windows" />
      </fieldset>

      <fieldset className="rt-section" disabled={disabled}>
        <legend><span className="rt-step">4</span>控除（手数料の率・順序・計算の基礎）</legend>
        <p className="rt-muted">既定は「窓口手数料を先に控除」です。選択肢が1つしか無い計算の基礎は自動で決めます。契約書と違うときは変えてください。</p>
        {form.windows.map((row, index) => {
          const options = windowBasisOptions(row.feeOrder);
          return (
            <div className="rt-row" key={index}>
              <div className="rt-row-head"><span>窓口{index + 1}{row.label ? `（${row.label}）` : ''}</span></div>
              <div className="on-form-grid">
                <PercentField label="窓口手数料率" required value={row.windowFee} onChange={(value) => setWindow(index, {...row, windowFee: value})} />
                <PercentField label="幹事手数料率" required value={row.managerFee} disabled={!form.managerPartnerId} hint={form.managerPartnerId ? undefined : '幹事なしのため0%'}
                  onChange={(value) => setWindow(index, {...row, managerFee: value})} />
                <FormField type="select" label="控除の順序" required value={row.feeOrder} options={FEE_ORDER_OPTIONS} onChange={(value) => setWindow(index, {...row, feeOrder: value})} />
                <FormField type="select" label="窓口手数料の計算の基礎" required value={row.windowFeeBasis} options={options.window} disabled={options.window.length <= 1}
                  onChange={(value) => setWindow(index, {...row, windowFeeBasis: value})} />
                <FormField type="select" label="幹事手数料の計算の基礎" required value={row.managerFeeBasis} options={options.manager} disabled={options.manager.length <= 1}
                  onChange={(value) => setWindow(index, {...row, managerFeeBasis: value})} />
              </div>
            </div>
          );
        })}
        <SectionErrors errors={errors} section="deductions" />
      </fieldset>

      <fieldset className="rt-section" disabled={disabled}>
        <legend><span className="rt-step">5</span>締め・報告・支払の日程</legend>
        <div className="rt-head">
          <p className="rt-muted">会計の計上月とは別の、分配の日程です。月末を超える日は月末にそろえます。休日の調整はしません。</p>
          <button type="button" className="secondary" onClick={() => setForm((current) => ({...current, phases: samplePhases()}))}>架空の日程例を入れる</button>
        </div>
        {form.phases.map((row, index) => (
          <div className="rt-row" key={index}>
            <div className="rt-row-head">
              <span>日程{index + 1}</span>
              {form.phases.length > 1 && <button type="button" className="text" onClick={() => setForm((current) => ({...current, phases: current.phases.filter((_, i) => i !== index)}))}>この日程を外す</button>}
            </div>
            <div className="on-form-grid">
              <FormField label="名称" required value={row.label} placeholder="例: 公開から1年は四半期" onChange={(value) => setPhase(index, 'label', value)} />
              <FormField type="date" label="開始日" required value={row.startsOn} onChange={(value) => setPhase(index, 'startsOn', value)} />
              <FormField type="date" label="終了日" required value={row.endsOn} onChange={(value) => setPhase(index, 'endsOn', value)} />
              <FormField type="date" label="初回の締め日" required value={row.firstCloseOn} onChange={(value) => setPhase(index, 'firstCloseOn', value)} />
              <FormField type="int" label="締めの間隔（か月）" required value={row.intervalMonths} hint="1〜12" onChange={(value) => setPhase(index, 'intervalMonths', value)} />
              <DayField label="締め日" value={row.closeDay} onChange={(value) => setPhase(index, 'closeDay', value)} />
              <FormField type="int" label="報告までの月数" required value={row.reportOffsetMonths} hint="締めと同じ月なら0（0〜24）" onChange={(value) => setPhase(index, 'reportOffsetMonths', value)} />
              <DayField label="報告予定日" value={row.reportDay} onChange={(value) => setPhase(index, 'reportDay', value)} />
              <FormField type="int" label="支払までの月数" required value={row.paymentOffsetMonths} hint="0〜24" onChange={(value) => setPhase(index, 'paymentOffsetMonths', value)} />
              <DayField label="支払予定日" value={row.paymentDay} onChange={(value) => setPhase(index, 'paymentDay', value)} />
              <FormField type="select" label="基準日の種類" required value={row.referenceType} options={REFERENCE_TYPE_OPTIONS} onChange={(value) => setPhase(index, 'referenceType', value)} />
              <FormField type="date" label="基準日（確定した日）" required value={row.referenceDate} onChange={(value) => setPhase(index, 'referenceDate', value)} />
            </div>
          </div>
        ))}
        <div className="rt-actions">
          <button type="button" className="secondary" onClick={() => setForm((current) => ({...current, phases: [...current.phases, blankPhase(current.phases.at(-1))]}))}>日程を追加（前の日程の翌日から）</button>
        </div>
        <SectionErrors errors={errors} section="schedule" />
      </fieldset>

      <FormField type="textarea" label="条件のメモ（任意）" value={form.note} disabled={disabled} onChange={(value) => setForm({...form, note: value})} />
      {errors.length > 0 && <Notice tone="error" message={`${errors.length}か所を確認してください。各段落の下に理由を出しています。`} />}
      <ProblemNotice error={error} onDismiss={() => setError(null)} />
      {retroactive && (
        <Notice tone="warn" title="確定済みのロイヤリティ報告書の計上月が変わります">
          <p>{retroactive.message}</p>
          <ul className="rt-errors">{retroactive.statements.map((row) => <li key={row.statementId}>{row.holderName}｜{monthText(row.closeMonth)}締め（計上月 {monthText(row.firstMonth)}〜{monthText(row.lastMonth)}）</li>)}</ul>
          <label className="check">
            <input type="checkbox" checked={retroactive.confirmed} onChange={(event) => setRetroactive({...retroactive, confirmed: event.target.checked})} />
            <span>次の報告書に「報告後の修正」の差額が出ることを確かめた上で登録する</span>
          </label>
        </Notice>
      )}
      <div className="on-form-actions">
        <button type="submit" disabled={disabled || (retroactive && !retroactive.confirmed)}>{saving ? '保存中…' : source ? '新しい版を保存' : '契約と版1を登録'}</button>
        <button type="button" className="text" disabled={saving} onClick={onClose}>{dirty ? '入力をやめて閉じる' : '閉じる'}</button>
      </div>
      <p className="rt-muted">料率・計算の基礎・経路は実際の契約に従って明示してください。入力例は架空です。実際の会計・優先回収・複数通貨・振込は扱いません。</p>
    </form>
  );
}

// ---- 契約条件の一覧 ----

function VersionDetail({contract, version, latest, editing, onEdit, form, readOnly}) {
  const manager = version.members?.find((row) => row.partner_id === version.manager_partner_id)?.partner_name || '幹事なし';
  return (
    <details open={editing || undefined}>
      <summary>条件版{version.version_no}{latest ? '（最新）' : ''}｜{version.effectiveFrom ? `${monthText(version.effectiveFrom)}から適用` : '最初の月から適用'}｜窓口{version.windows.length}件｜日程{version.phases.length}件｜幹事 {manager}</summary>
      <div className="committee-version">
        <div className="rt-chips">{(version.members || []).map((row) => <span className="rt-chip" key={row.id ?? row.partner_id}>{row.partner_name}｜持分 {percentText(row.share_bps)}</span>)}</div>
        <ul className="rt-errors">{version.windows.map((row) => <li key={row.id}>{windowSummary(row)}・{routeText(row.route)}・窓口基礎 {feeBasisText(row.window_fee_basis)}・幹事基礎 {feeBasisText(row.manager_fee_basis)}</li>)}</ul>
        <div className="rt-table-wrap">
          <table className="rt-table">
            <thead><tr><th>日程</th><th>期間</th><th>初回の締め</th><th>締め</th><th>報告</th><th>支払</th><th>基準日</th></tr></thead>
            <tbody>{version.phases.map((row) => (
              <tr key={row.id}>
                <td>{row.label}</td><td>{dateJst(row.starts_on)}〜{dateJst(row.ends_on)}</td><td>{dateJst(row.first_close_on)}</td>
                <td>{intervalText(row.interval_months)}・{dayText(row.close_day)}</td><td>{offsetText(row.report_offset_months, row.report_day)}</td>
                <td>{offsetText(row.payment_offset_months, row.payment_day)}</td><td>{referenceTypeText(row.reference_type)} {dateJst(row.reference_date)}</td>
              </tr>
            ))}</tbody>
          </table>
        </div>
        {version.funding && <p className="rt-muted">製作費の総額 {yen(version.funding.productionCostYen)}／出資 {version.funding.investments.map((row) => `${version.members?.find((m) => m.partner_id === row.partnerId)?.partner_name || '出資者'} ${yen(row.amountYen)}`).join('・')}</p>}
        {version.note && <p className="rt-muted">メモ：{version.note}</p>}
        <div className="rt-actions">
          <button type="button" className={editing ? '' : 'secondary'} aria-expanded={editing} disabled={readOnly} onClick={onEdit}>{editing ? '新しい版の入力を閉じる' : 'この版から新しい版を作る'}</button>
        </div>
        {editing && <div className="rt-inline"><h4>「{contract.contract_code}」の新しい版（版{(latestVersion(contract.versions)?.version_no || 0) + 1}）</h4>{form}</div>}
      </div>
    </details>
  );
}

function TermsSection({work, contracts, intakes, request, readOnly, onChanged}) {
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState(null);
  const [notice, setNotice] = useState('');
  const saved = (message) => { setCreating(false); setEditing(null); setNotice(message); onChanged(); };
  return (
    <section className="card rp-report" aria-label={T.terms}>
      <div className="rt-head">
        <div>
          <h2>{T.terms}（{contracts.length}件）</h2>
          <p className="rt-muted">条件の版は登録後に変えられません。改定は前の版を残して新しい版を作ります。</p>
        </div>
        <button type="button" className={creating ? '' : 'secondary'} aria-expanded={creating} disabled={readOnly} onClick={() => { setCreating((value) => !value); setEditing(null); }}>
          {creating ? '登録の入力を閉じる' : T.register}
        </button>
      </div>
      {notice && <Notice tone="ok" message={notice} onDismiss={() => setNotice('')} />}
      {creating && (
        <div className="rt-inline">
          <h4>委員会の契約条件を登録</h4>
          <TermsForm work={work} contracts={contracts} intakes={intakes} source={null} request={request} readOnly={readOnly} onSaved={saved} onClose={() => setCreating(false)} />
        </div>
      )}
      {contracts.length === 0
        ? <p className="rt-muted">この作品の委員会の契約はまだありません。{T.register}から入力します。</p>
        : contracts.map((contract) => {
          const latest = latestVersion(contract.versions);
          return (
            <article className="committee-contract" key={contract.id}>
              <span className="badge">{contract.contract_code}</span>
              <h3>{contract.title}</h3>
              <small>調達案件 {contract.intake_case_code}／契約書 {contract.document_title} {contract.document_version || ''}</small>
              {[...contract.versions].reverse().map((version) => (
                <VersionDetail key={version.id} contract={contract} version={version} latest={version.id === latest?.id} editing={editing === version.id} readOnly={readOnly}
                  onEdit={() => { if (!readOnly) { setEditing((value) => (value === version.id ? null : version.id)); setCreating(false); } }}
                  form={editing === version.id && (
                    <TermsForm work={work} contracts={contracts} intakes={intakes} source={{contract, version}} request={request} readOnly={readOnly} onSaved={saved} onClose={() => setEditing(null)} />
                  )} />
              ))}
            </article>
          );
        })}
    </section>
  );
}

// ---- 期間報告の表示（印刷にも使う） ----

function ReportView({calculation, snapshotId, id, partners}) {
  if (!calculation) return null;
  const partnerName = (partnerId) => calculation.members.find((row) => (row.partner_id ?? row.partnerId) === partnerId)?.partner_name
    || partners.find((row) => row.id === partnerId)?.name || '名称未登録の取引先';
  const keyOf = new Map(calculation.selectedReports.map((row) => [row.reportId, row.reportKey]));
  const totals = calculation.totals;
  const tiles = [
    ['控除前の報告額', totals.grossReported], ['控除後の報告額', totals.netReported], ['PF控除後の原資', totals.platformNet], ['窓口手数料', totals.windowFee],
    ['幹事手数料', totals.managerFee], ['明示した経費', totals.expenseTotal], ['権利処理費の控除', totals.royaltyDeductions || 0], ['製作費回収の控除', totals.productionRecoupDeductions || 0],
    ['分配原資', totals.distributionPool], ['未配分の端数', totals.residual],
  ];
  const sum = (rows, key) => rows.reduce((total, row) => total + (Number(row[key]) || 0), 0);
  return (
    <article id={id} className="committee-print card rt-page">
      <header className="committee-report-head">
        <div>
          <p className="rt-eyebrow">製作委員会 収支・分配予定報告（下書き）</p>
          <h2>{calculation.contract.code}｜{calculation.contract.title}</h2>
          <p>条件版{calculation.termVersion.versionNo}｜{snapshotId ? '保存済みの報告' : '保存前の確認（まだ保存していません）'}</p>
        </div>
        <span className="badge unknown">下書き・未確認</span>
      </header>
      <dl className="committee-meta">
        <div><dt>対象期間</dt><dd>{dateJst(calculation.period.start)}〜{dateJst(calculation.period.end)}{calculation.period.stub ? '（端数期間）' : ''}</dd></div>
        <div><dt>期間に含める売上</dt><dd>{periodDateBasisText(calculation.periodDateBasis)}</dd></div>
        <div><dt>締め日</dt><dd>{dateJst(calculation.period.closeOn)}</dd></div>
        <div><dt>報告予定日</dt><dd>{dateJst(calculation.period.reportOn)}</dd></div>
        <div><dt>支払予定日</dt><dd>{dateJst(calculation.period.paymentOn)}</dd></div>
        <div><dt>契約書の参照</dt><dd>{calculation.contract.documentTitle}／{calculation.contract.documentVersion || '版未確認'}／{calculation.contract.documentReference}</dd></div>
      </dl>
      <p className="income-caution">{japaneseMessage(calculation.scopeNote)} 金額は円・税抜です。これは予定の試算で、入金済み・支払済み・最終利益を示しません。</p>
      <section>
        <h3>全体の集計</h3>
        <div className="rp-tiles">{tiles.map(([label, value]) => <div key={label}><span>{label}</span><strong>{yen(value)}</strong></div>)}</div>
        {totals.platformFee === null || totals.platformFee === undefined ? <p className="rt-state is-warn">控除後の額で受けた報告を含むため、PF控除額の合計は未確認です（二重に控除しません）。</p> : null}
      </section>
      {calculation.windows.map((window) => (
        <section className="committee-window-report" key={window.windowId}>
          <div className="rt-head">
            <div>
              <h3>{windowKindText(window.kind)}｜{window.label}</h3>
              <p className="rt-muted">{routeText(window.route)}／{feeOrderText(window.feeOrder)}／窓口手数料の基礎 {feeBasisText(window.windowFeeBasis)}／幹事手数料の基礎 {feeBasisText(window.managerFeeBasis)}</p>
            </div>
            <strong>分配原資 {yen(window.distributionPool)}</strong>
          </div>
          <div className="rt-table-wrap">
            <table className="rt-table">
              <thead><tr><th className="num">控除前の報告額</th><th className="num">控除後の報告額</th><th className="num">PF控除</th><th className="num">PF控除後</th><th className="num">窓口手数料</th><th className="num">幹事手数料</th><th className="num">経費</th><th className="num">分配原資</th></tr></thead>
              <tbody><tr>
                <td className="num">{int(window.grossReported)}</td><td className="num">{int(window.netReported)}</td>
                <td className="num">{window.hasNetBasis ? `${int(window.platformFeeKnown)}＋控除後の分は未確認` : int(window.platformFeeKnown)}</td>
                <td className="num">{int(window.platformNet)}</td><td className="num">{int(window.windowFee)}</td><td className="num">{int(window.managerFee)}</td>
                <td className="num">{int(window.expenseTotal)}</td><td className="num">{int(window.distributionPool)}</td>
              </tr></tbody>
            </table>
          </div>
          <h4>出資者への分配（円）</h4>
          <div className="rt-table-wrap">
            <table className="rt-table">
              <thead><tr><th>受取人</th><th className="num">持分</th><th className="num">分配予定額</th><th>手数料の受取</th><th>経路</th></tr></thead>
              <tbody>{window.payouts.map((row) => (
                <tr key={row.partnerId}>
                  <td>{partnerName(row.partnerId)}</td><td className="num">{percentText(row.shareBps)}</td><td className="num">{int(row.amount)}</td>
                  <td>{[row.windowFeeRecipient ? '窓口手数料' : '', row.managerFeeRecipient ? '幹事手数料' : ''].filter(Boolean).join('・') || 'なし'}</td><td>{routeText(row.route)}</td>
                </tr>
              ))}</tbody>
              <tfoot>
                <tr><th>分配の合計</th><td /><td className="num">{int(sum(window.payouts, 'amount'))}</td><td colSpan="2">未配分の端数 {yen(window.residual)}</td></tr>
                <tr><th colSpan="3">配分の検算（分配の合計＋端数＝分配原資）</th><td colSpan="2"><span className={`rt-state ${window.conservation.balanced ? 'is-ok' : 'is-warn'}`}>{window.conservation.balanced ? '一致' : '不一致'}</span></td></tr>
              </tfoot>
            </table>
          </div>
        </section>
      ))}
      <details open>
        <summary>根拠：選んだ売上報告と元の明細</summary>
        <div className="rt-table-wrap">
          <table className="rt-table">
            <thead><tr><th>売上報告</th><th>販路</th><th>報告額の基準</th><th className="num">作品配賦後の額（円）</th><th>対象期間</th><th>計上月</th><th>受領日</th></tr></thead>
            <tbody>{calculation.selectedReports.map((row) => (
              <tr key={row.reportId}>
                <td>{row.reportKey}</td><td>{windowKindText(row.kind)}</td><td>{reportBasisText(row.reportBasis)}</td><td className="num">{int(row.amount)}</td>
                <td>{dateJst(row.periodFrom)}〜{dateJst(row.periodTo)}</td><td>{row.accountingMonth ? monthText(row.accountingMonth) : '未確認'}</td><td>{row.reportReceivedOn ? dateJst(row.reportReceivedOn) : '未確認'}</td>
              </tr>
            ))}</tbody>
            <tfoot><tr><th colSpan="3">合計（{calculation.selectedReports.length}件）</th><td className="num">{int(sum(calculation.selectedReports, 'amount'))}</td><td colSpan="3" /></tr></tfoot>
          </table>
        </div>
        <div className="rt-table-wrap">
          <table className="rt-table">
            <thead><tr><th>売上報告・原本の行</th><th>内容</th><th>販売期間</th><th className="num">配賦率</th><th className="num">配賦後の税抜額（円）</th><th>計上月</th></tr></thead>
            <tbody>{calculation.lines.map((row) => (
              <tr key={`${row.reportId}-${row.saleId}`}>
                <td>{keyOf.get(row.reportId) || '売上報告'}・{row.sourceRow ? `原本の${row.sourceRow}行目` : '手入力'}</td><td>{row.description}</td>
                <td>{dateJst(row.salesPeriodFrom)}〜{dateJst(row.salesPeriodTo)}</td><td className="num">{percentText(row.allocationBps)}</td>
                <td className="num">{int(row.allocatedAmountExTax)}</td><td>{row.accountingMonth ? monthText(row.accountingMonth) : '未確認'}</td>
              </tr>
            ))}</tbody>
            <tfoot><tr><th colSpan="4">合計（{calculation.lines.length}行）</th><td className="num">{int(sum(calculation.lines, 'allocatedAmountExTax'))}</td><td /></tr></tfoot>
          </table>
        </div>
      </details>
      <details>
        <summary>控除した経費（{calculation.selectedExpenses.length}件）</summary>
        {calculation.selectedExpenses.length
          ? (
            <div className="rt-table-wrap">
              <table className="rt-table">
                <thead><tr><th>内容</th><th>発生日</th><th>計上月</th><th className="num">税抜額（円）</th></tr></thead>
                <tbody>{calculation.selectedExpenses.map((row) => <tr key={row.expenseId}><td>{row.description}</td><td>{dateJst(row.incurredOn)}</td><td>{monthText(row.accountingMonth)}</td><td className="num">{int(row.amount)}</td></tr>)}</tbody>
                <tfoot><tr><th colSpan="3">合計</th><td className="num">{int(sum(calculation.selectedExpenses, 'amount'))}</td></tr></tfoot>
              </table>
            </div>
          )
          : <p className="rt-muted">この報告で控除した経費はありません。</p>}
      </details>
      <details>
        <summary>この報告に入れなかった売上報告（{calculation.unallocatedReports.length}件）</summary>
        {calculation.unallocatedReports.length
          ? <ul className="rt-errors">{calculation.unallocatedReports.map((row) => <li key={row.id}>{row.key}｜{windowKindText(row.kind)}｜{row.reason}</li>)}</ul>
          : <p className="rt-muted">ありません。</p>}
      </details>
      <p className="rt-muted">端数の扱い：{calculation.roundingRule}</p>
    </article>
  );
}

// ---- 期間報告の作成 ----

function ReportBuilder({work, contracts, snapshots, partners, request, readOnly, onSaved}) {
  const defaults = useMemo(() => builderDefaults({contracts, snapshots}), [contracts, snapshots]);
  const [termVersionId, setTermVersionId] = useState(defaults.termVersionId);
  const [periodDateBasis, setPeriodDateBasis] = useState(defaults.periodDateBasis);
  const [periods, setPeriods] = useState([]);
  const [periodIndex, setPeriodIndex] = useState('');
  const [sources, setSources] = useState(null);
  const [reportLinks, setReportLinks] = useState([]);
  const [expenseAllocations, setExpenseAllocations] = useState([]);
  const [deductions, setDeductions] = useState([]);
  const [allowStub, setAllowStub] = useState(false);
  const [preview, setPreview] = useState(null);
  const [problems, setProblems] = useState([]);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [sourceRevision, setSourceRevision] = useState(0);
  // 締め期間と集計元は別々に読み込むので、古い応答を捨てる番号も別にする（共有すると、版を変えたときに期間の応答を捨ててしまう）
  const periodsRequest = useRef(0);
  const sourcesRequest = useRef(0);
  const versions = useMemo(() => contracts.flatMap((contract) => contract.versions.map((version) => ({contract, version}))), [contracts]);
  const chosen = versions.find((item) => String(item.version.id) === String(termVersionId));
  const basisDefaults = useMemo(() => basisByKind(snapshots, chosen?.contract.id ?? null), [snapshots, chosen?.contract.id]);
  const dirty = reportLinks.length > 0 || expenseAllocations.length > 0 || deductions.length > 0;
  useUnsaved(dirty && !preview, '期間報告の作成');

  // 既定値は読み込み後に届くことがある。利用者が選んだ値は上書きしない
  useEffect(() => {
    if (!termVersionId && defaults.termVersionId) setTermVersionId(defaults.termVersionId);
    if (!periodDateBasis && defaults.periodDateBasis) setPeriodDateBasis(defaults.periodDateBasis);
  }, [defaults]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    setPreview(null); setSources(null); setReportLinks([]); setExpenseAllocations([]); setDeductions([]);
    // 前の版の期間を残したまま集計元を読まないよう、先に空にする
    setPeriods([]); setPeriodIndex('');
    if (!termVersionId) return undefined;
    const id = ++periodsRequest.current;
    request(`/committee/periods?termVersionId=${termVersionId}`).then((result) => {
      if (id !== periodsRequest.current) return;
      setPeriods(result.periods);
      setPeriodIndex(nextPeriodIndex(result.periods, snapshots, chosen?.contract.id ?? null));
    }).catch((cause) => { if (id === periodsRequest.current) setError(translateError(cause)); });
    return () => { periodsRequest.current += 1; };
  }, [termVersionId]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    setPreview(null); setSources(null); setReportLinks([]); setExpenseAllocations([]); setDeductions([]); setAllowStub(false);
    if (!termVersionId || !periodIndex || !periodDateBasis) return undefined;
    const id = ++sourcesRequest.current;
    const query = new URLSearchParams({workId: String(work.id), termVersionId: String(termVersionId), periodIndex: String(periodIndex), periodDateBasis});
    request(`/committee/sources?${query}`).then((result) => { if (id === sourcesRequest.current) setSources(result); })
      .catch((cause) => { if (id === sourcesRequest.current) setError(translateError(cause)); });
    return () => { sourcesRequest.current += 1; };
  }, [work.id, termVersionId, periodIndex, periodDateBasis, sourceRevision]); // eslint-disable-line react-hooks/exhaustive-deps

  const selectedPeriod = periods.find((row) => row.index === Number(periodIndex));
  const windowsOf = sources?.windows || [];
  const toggleReport = (row, checked) => {
    setReportLinks((current) => (checked ? [...current, {reportId: row.id, reportBasis: basisDefaults[row.kind] || '', kind: row.kind, reportKey: row.report_key}] : current.filter((link) => link.reportId !== row.id)));
    setPreview(null);
  };
  const selectAll = () => {
    const eligible = (sources?.candidateReports || []).filter((row) => row.eligible && !reportLinks.some((link) => link.reportId === row.id));
    setReportLinks((current) => [...current, ...eligible.map((row) => ({reportId: row.id, reportBasis: basisDefaults[row.kind] || '', kind: row.kind, reportKey: row.report_key}))]);
    setPreview(null);
  };
  const setBasis = (reportId, value) => { setReportLinks((current) => current.map((row) => (row.reportId === reportId ? {...row, reportBasis: value} : row))); setPreview(null); };
  const toggleExpense = (row, checked) => {
    setExpenseAllocations((current) => (checked ? [...current, {expenseId: row.id, windowId: windowsOf.length === 1 ? String(windowsOf[0].id) : ''}] : current.filter((item) => item.expenseId !== row.id)));
    setPreview(null);
  };
  const setExpenseWindow = (expenseId, value) => { setExpenseAllocations((current) => current.map((row) => (row.expenseId === expenseId ? {...row, windowId: value} : row))); setPreview(null); };

  async function build() {
    setError(null);
    const issues = [];
    if (!reportLinks.length && !expenseAllocations.length) issues.push('売上報告か控除する経費を1件以上選んでください');
    reportLinks.forEach((row) => { if (!row.reportBasis) issues.push(`売上報告「${row.reportKey}」の報告額の基準を選んでください`); });
    expenseAllocations.forEach((row) => { if (!row.windowId) issues.push('控除する経費の販路を選んでください'); });
    if (selectedPeriod?.stub && !allowStub) issues.push('端数期間です。契約上この期間を報告期間にするときは「端数期間を採用する」に印を付けてください');
    const built = deductionPayload(deductions);
    issues.push(...built.errors);
    setProblems(issues);
    if (issues.length) return;
    setBusy(true);
    try {
      const result = await request('/committee/previews', {method: 'POST', body: JSON.stringify({
        workId: work.id, termVersionId: Number(termVersionId), periodIndex: Number(periodIndex), periodDateBasis, allowStub, deductions: built.deductions,
        reportLinks: reportLinks.map((row) => ({reportId: row.reportId, reportBasis: row.reportBasis})),
        expenseAllocations: expenseAllocations.map((row) => ({expenseId: row.expenseId, windowId: Number(row.windowId)})),
      })});
      setPreview(result);
    } catch (cause) {
      setError(translateError(cause));
    } finally {
      setBusy(false);
    }
  }

  async function save() {
    setBusy(true);
    setError(null);
    try {
      await request('/committee/snapshots', {method: 'POST', body: JSON.stringify({token: preview.token})});
      const period = selectedPeriod ? `${dateJst(selectedPeriod.start)}〜${dateJst(selectedPeriod.end)}` : '';
      setPreview(null); setReportLinks([]); setExpenseAllocations([]); setDeductions([]); setSourceRevision((value) => value + 1);
      onSaved(`期間報告（${period}）を下書きとして保存しました。保存済みの一覧に出ます`);
    } catch (cause) {
      setError(translateError(cause));
    } finally {
      setBusy(false);
    }
  }

  const versionOptions = versions.map(({contract, version}) => ({value: String(version.id), label: `${contract.contract_code}｜版${version.version_no}${latestVersion(contract.versions)?.id === version.id ? '（最新）' : ''}`}));
  const periodOptions = periods.map((row) => ({value: String(row.index), label: `${dateJst(row.start)}〜${dateJst(row.end)}${row.stub ? '（端数期間）' : ''}${snapshots.some((s) => s.term_version_id === Number(termVersionId) && s.period_index === row.index) ? '・保存済み' : ''}`}));
  const disabled = readOnly || busy;
  return (
    <div className="stack">
      <p className="rt-muted">条件版・締め期間・期間に含める売上の決め方を選び、売上報告と控除する経費を明示すると、サーバーで計算し直した確認画面が出ます。確認してから保存します。</p>
      <div className="on-form-grid">
        <FormField type="select" label="条件版" required value={termVersionId} options={versionOptions} disabled={disabled} hint="既定は直近の報告の契約の最新の版です" onChange={setTermVersionId} />
        <FormField type="select" label="締め期間" required value={periodIndex} options={periodOptions} disabled={disabled || !termVersionId}
          hint={periods.length && !periodIndex ? 'すべての期間が保存済みです' : '既定は保存済みの最後の期間の次です'} onChange={setPeriodIndex} />
        <FormField type="select" label="期間に含める売上" required value={periodDateBasis} options={PERIOD_DATE_BASIS_OPTIONS} disabled={disabled || !periodIndex}
          hint={defaults.periodDateBasis ? '既定は前回の報告と同じ決め方です' : '契約書の決め方を選んでください'} onChange={setPeriodDateBasis} />
      </div>
      {selectedPeriod && <p className="relation">締め {dateJst(selectedPeriod.closeOn)}／報告予定 {dateJst(selectedPeriod.reportOn)}／支払予定 {dateJst(selectedPeriod.paymentOn)}（休日の調整なし）</p>}
      {sources && (
        <>
          <fieldset className="rt-section" disabled={disabled}>
            <legend>対象の売上報告</legend>
            {sources.candidateReports.length === 0
              ? <p className="rt-muted">この作品の有効な売上報告はありません。</p>
              : (
                <>
                  <div className="rt-actions">
                    <button type="button" className="secondary" onClick={selectAll} disabled={!sources.candidateReports.some((row) => row.eligible)}>選べる報告をすべて選ぶ</button>
                    <span className="rt-muted">報告額の基準は、前回の報告の同じ販路の基準を既定にします。</span>
                  </div>
                  {sources.candidateReports.map((row) => {
                    const link = reportLinks.find((item) => item.reportId === row.id);
                    return (
                      <div className={`committee-source ${row.eligible ? '' : 'disabled'}`} key={row.id}>
                        <label className="check">
                          <input type="checkbox" disabled={!row.eligible} checked={Boolean(link)} onChange={(event) => toggleReport(row, event.target.checked)} />
                          <span>{row.report_key}｜{windowKindText(row.kind)}｜期間 {dateJst(row.period_from)}〜{dateJst(row.period_to)}｜計上月 {row.accounting_month ? monthText(row.accounting_month) : '未確認'}｜受領 {row.reportReceivedOn ? dateJst(row.reportReceivedOn) : '未確認'}</span>
                        </label>
                        {link && <FormField type="select" label="報告額の基準" required value={link.reportBasis} options={REPORT_BASIS_OPTIONS} onChange={(value) => setBasis(row.id, value)} />}
                        {!row.eligible && <small>{row.reason}</small>}
                      </div>
                    );
                  })}
                </>
              )}
          </fieldset>
          <fieldset className="rt-section" disabled={disabled}>
            <legend>窓口ごとに控除する登録済みの経費</legend>
            {sources.availableExpenses.length === 0
              ? <p className="rt-muted">この作品の登録済みの経費はありません。</p>
              : sources.availableExpenses.map((row) => {
                const allocation = expenseAllocations.find((item) => item.expenseId === row.id);
                return (
                  <div className={`committee-source ${row.eligible ? '' : 'disabled'}`} key={row.id}>
                    <label className="check">
                      <input type="checkbox" disabled={!row.eligible} checked={Boolean(allocation)} onChange={(event) => toggleExpense(row, event.target.checked)} />
                      <span>{row.description}｜{dateJst(row.incurred_on)}｜{yen(row.actual_ex_tax)}</span>
                    </label>
                    {allocation && <FormField type="select" label="控除する販路" required value={allocation.windowId}
                      options={windowsOf.map((window) => ({value: String(window.id), label: `${windowKindText(window.kind)}｜${window.label}`}))} onChange={(value) => setExpenseWindow(row.id, value)} />}
                    {!row.eligible && <small>{row.reason}</small>}
                  </div>
                );
              })}
          </fieldset>
          <details className="rt-section">
            <summary>権利処理費・製作費の回収を控除する（{deductions.length}件）</summary>
            <DeductionFields rows={deductions} disabled={disabled} partners={partners} funding={sources.funding}
              reports={reportLinks.map((row) => ({reportId: row.reportId, label: `${row.reportKey}（${windowKindText(row.kind)}）`}))}
              onChange={(rows) => { setDeductions(rows); setPreview(null); }} />
          </details>
          {selectedPeriod?.stub && (
            <label className="check stub-confirm">
              <input type="checkbox" checked={allowStub} disabled={disabled} onChange={(event) => setAllowStub(event.target.checked)} />
              <span>端数期間を採用する（契約上、この端数期間を報告期間にする）</span>
            </label>
          )}
          {problems.length > 0 && <Notice tone="error" title={`${problems.length}か所を確認してください`}><ul className="rt-errors">{problems.map((text) => <li key={text}>{text}</li>)}</ul></Notice>}
          <div className="on-form-actions">
            <button type="button" disabled={disabled} onClick={build}>{busy && !preview ? '計算中…' : '根拠と金額を計算して確認する'}</button>
            {dirty && !preview && <button type="button" className="text" disabled={busy} onClick={() => { setReportLinks([]); setExpenseAllocations([]); setDeductions([]); setProblems([]); }}>選択を解除</button>}
          </div>
        </>
      )}
      <ProblemNotice error={error} onDismiss={() => setError(null)} />
      {preview && (
        <div className="committee-preview">
          <Notice tone="info" title="まだ保存していません" message="下の内容で保存するか、戻って選び直してください。保存した報告は後から変えられません（訂正は次の報告で行います）。"
            actions={(
              <>
                <button type="button" disabled={disabled} onClick={save}>{busy ? '保存中…' : 'この内容で下書きとして保存'}</button>
                <button type="button" className="secondary" disabled={busy} onClick={() => setPreview(null)}>戻って選び直す</button>
                <button type="button" className="secondary" onClick={() => printReport('committee-preview-report')}>この確認画面を印刷</button>
              </>
            )} />
          <ReportView id="committee-preview-report" calculation={preview} partners={partners} />
        </div>
      )}
    </div>
  );
}

const SNAPSHOT_COLUMNS = [
  {key: 'periodText', label: '対象期間', type: 'text', sticky: true},
  {key: 'contractText', label: '契約', type: 'text', wrap: true},
  {key: 'versionText', label: '条件版', type: 'text'},
  {key: 'basisText', label: '期間に含めた売上', type: 'text'},
  {key: 'platformNet', label: 'PF控除後の原資', type: 'yen', total: 'sum'},
  {key: 'pool', label: '分配原資', type: 'yen', total: 'sum'},
  {key: 'statusText', label: '状態', type: 'text'},
  {key: 'created_at', label: '保存日時', type: 'datetime'},
  {key: 'id', label: '保存番号', type: 'id', hidden: true},
];

function LegacyPanel({work, state, partners, request, readOnly, onChanged}) {
  const [building, setBuilding] = useState(false);
  const [notice, setNotice] = useState('');
  const rows = useMemo(() => snapshotRows(state.snapshots, state.contracts), [state.snapshots, state.contracts]);
  return (
    <>
      <section className="card rp-report" aria-label={T.saved}>
        <div className="rt-head">
          <div>
            <h2>{T.saved}（{rows.length}件）</h2>
            <p className="rt-muted">保存したときの条件版・売上・経費・計算結果をそのまま持ちます。後の訂正や条件の変更では書き換わりません。行を押すと報告の中身と印刷が開きます。</p>
          </div>
          <button type="button" className={building ? '' : 'secondary'} aria-expanded={building} disabled={readOnly || !state.contracts.length}
            onClick={() => setBuilding((value) => !value)}>{building ? '作成の入力を閉じる' : `＋${T.builder}`}</button>
        </div>
        {!state.contracts.length && <p className="rt-muted">期間報告は、下の「{T.terms}」を登録すると作れます。</p>}
        {notice && <Notice tone="ok" message={notice} onDismiss={() => setNotice('')} />}
        {building && (
          <div className="rt-inline">
            <h4>{T.builder}</h4>
            <ReportBuilder work={work} contracts={state.contracts} snapshots={state.snapshots} partners={partners} request={request} readOnly={readOnly}
              onSaved={(message) => { setNotice(message); setBuilding(false); onChanged(); }} />
          </div>
        )}
        <DataGrid columns={SNAPSHOT_COLUMNS} rows={rows} rowKey="id" persistKey="committee-snapshots" ariaLabel={T.saved}
          emptyText="保存済みの期間報告はありません"
          exportSpec={{name: '製作委員会の期間報告', title: '製作委員会の保存済み期間報告', conditions: [['作品', work.title || '']], notes: ['金額は円・税抜。下書き（未確認）の予定試算です。']}}
          renderDetail={(row) => (
            <div className="stack">
              <div className="rt-actions"><button type="button" className="secondary" onClick={() => printReport(`committee-snapshot-${row.id}`)}>この報告を印刷</button></div>
              <ReportView id={`committee-snapshot-${row.id}`} calculation={row.calculation} snapshotId={row.id} partners={partners} />
            </div>
          )} />
      </section>
      <TermsSection work={work} contracts={state.contracts} intakes={state.intakes} request={request} readOnly={readOnly} onChanged={onChanged} />
    </>
  );
}

export default function Committee({data, request}) {
  const shell = useShell();
  const req = request || shell.request;
  const readOnly = Boolean(shell.readOnly);
  const workId = data.selectedWorkId;
  const found = data.selectedWork || data.works?.find((item) => item.id === workId) || null;
  const work = useMemo(() => found || {id: workId}, [found, workId]);
  const [state, setState] = useState({workId: null, contracts: [], intakes: [], snapshots: []});
  const [joint, setJoint] = useState([]);
  const [calcLocal, setCalcLocal] = useState(null);
  const [error, setError] = useState(null);
  const [revision, setRevision] = useState(0);
  const requestId = useRef(0);
  useEffect(() => {
    let live = true;
    setJoint([]);
    if (workId) {
      req(`/committee/joint?workId=${workId}`).then((result) => {
        if (!live) return;
        setJoint(result.contracts || []);
      }).catch((cause) => { if (live) setError(cause); });
    }
    return () => { live = false; };
  }, [workId]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!workId) return undefined;
    const id = ++requestId.current;
    setError(null);
    Promise.all([req(`/committee/contracts?workId=${workId}`), req(`/intakes?workId=${workId}`), req(`/committee/snapshots?workId=${workId}`)])
      .then(([contracts, intakes, snapshots]) => {
        if (id === requestId.current) setState({workId, contracts: contracts.contracts, intakes: intakes.cases.filter((row) => row.intake_type === 'committee'), snapshots: snapshots.rows});
      })
      .catch((cause) => { if (id === requestId.current) setError(cause); });
    return () => { requestId.current += 1; };
  }, [workId, revision]); // eslint-disable-line react-hooks/exhaustive-deps
  const changed = () => setRevision((value) => value + 1);
  const current = state.workId === workId ? state : {contracts: [], intakes: [], snapshots: []};
  const calc = shell.getParam?.('calc', null) || calcLocal || (joint.length ? 'joint' : 'legacy');
  const selectCalc = (id) => { setCalcLocal(id); shell.setParam?.('calc', id, {replace: true}); };

  if (!workId) return <Notice tone="info" message="作品を選ぶと、製作委員会の契約と期間報告を表示します。" />;
  const legacy = <LegacyPanel key={workId} work={work} state={current} partners={data.partners || []} request={req} readOnly={readOnly} onChanged={changed} />;
  return (
    <div className="stack committee-page rt-page">
      <section className="card rt-intro print-hide">
        <p className="rt-eyebrow">{T.eyebrow}</p>
        <h2>{T.title}</h2>
        <p>{T.lead}</p>
        <ol className="rt-flow" aria-label="分配の流れ">{COMMITTEE_FLOW.map((step) => <li key={step}>{step}</li>)}</ol>
        <div className="rp-tiles">
          <div><span>委員会の契約</span><strong>{current.contracts.length}件</strong></div>
          <div><span>条件版</span><strong>{current.contracts.flatMap((row) => row.versions).length}件</strong></div>
          <div><span>保存済みの期間報告</span><strong>{current.snapshots.length}件</strong></div>
          {joint.length > 0 && <div><span>共同製作の契約</span><strong>{joint.length}件</strong></div>}
        </div>
      </section>
      <ProblemNotice error={error} title="製作委員会の情報を読み込めませんでした" onRetry={changed} />
      {joint.length > 0
        ? (
          <Tabs label="計算の方式" value={calc} onChange={selectCalc}
            tabs={[{id: 'joint', label: T.joint, badge: joint.length}, {id: 'legacy', label: T.legacy, badge: current.snapshots.length || undefined}]}>
            {(active) => (active === 'joint'
              ? <JointCommittee key={`${workId}:${joint[0].id}`} workId={workId} contractId={joint[0].id} request={req} role={data.currentUser?.role} />
              : <div className="stack">{legacy}</div>)}
          </Tabs>
        )
        : legacy}
    </div>
  );
}
