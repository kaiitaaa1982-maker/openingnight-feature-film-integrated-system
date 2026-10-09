// 権利の調達。作品ごとの調達案件（権利の受け方・契約書の参照・権利範囲・参加者）を版として残す。
// 並び: 調達案件の一覧（上）→ 行を押すと内容・不足・分配契約との関連。登録は「＋調達案件を登録」で開く折りたたみ。
// 改訂は押した案件の詳細の中に開く。媒体は流通区分マスタの流通名、地域は選択肢（その他は入力）から選ぶ。
import React, {useEffect, useId, useMemo, useRef, useState} from 'react';
import {useShell} from './shell/context.mjs';
import {DataGrid} from './ui/DataGrid.jsx';
import {Notice} from './ui/Notice.jsx';
import {FormField} from './ui/FormField.jsx';
import {EntityPicker} from './ui/EntityPicker.jsx';
import {toEntityItems} from './ui/entity-match.mjs';
import {yen} from './ui/format.mjs';
import {PercentField, ProblemNotice} from './CommitteeFinanceFields.jsx';
import {territoryOptions, territoryInput, territoryFromInput, territoryLabel, OTHER_TERRITORY} from './sales-ops/sales-catalog-model.mjs';
import {
  SCREEN_TEXT, INTAKE_TYPE_OPTIONS, EXCLUSIVITY_OPTIONS, intakeTypeText, exclusivityText, percentText, parsePercent, mediaOptions,
  newIntakeForm, intakeFormFromCase, intakePayload, intakeRows, blankDocument, blankScope, blankParticipant, translateError, japaneseMessage,
} from './rights/rights-ui-model.mjs';
import './reports/reports.css';
import './RightsReports.css';

const T = SCREEN_TEXT.intake;
const participantTitle = (type) => (type === 'committee' ? '出資者（委員会の参加者）' : type === 'entrusted' ? '委託者' : '権利の保有主体');
const territoryOf = (scope) => territoryFromInput(scope.territory, scope.territoryOther);

function RowActions({onAdd, onRemove, addLabel, removeLabel, disabled}) {
  return (
    <div className="rt-actions">
      <button type="button" className="secondary" disabled={disabled} onClick={onAdd}>{addLabel}</button>
      {onRemove && <button type="button" className="text" disabled={disabled} onClick={onRemove}>{removeLabel}</button>}
    </div>
  );
}

// 調達案件の入力（新規・改訂）。保存すると版は変えられない。不足は次の改訂で補う。
function IntakeForm({work, cases, source, partners, types, request, readOnly, onSaved, onClose}) {
  const shell = useShell();
  const formId = `intake${useId().replace(/:/g, '')}`;
  // 作品・改訂元が変わったときだけ初期値を作り直す（一覧の再読込では入力を消さない）
  const initial = useMemo(() => (source ? intakeFormFromCase(source, cases, territoryInput) : newIntakeForm(work, cases)), [source?.id, work?.id]); // eslint-disable-line react-hooks/exhaustive-deps
  const [form, setForm] = useState(initial);
  const [problems, setProblems] = useState([]);
  const [error, setError] = useState(null);
  const [saving, setSaving] = useState(false);
  const baseline = useRef(JSON.stringify(initial));
  useEffect(() => { setForm(initial); baseline.current = JSON.stringify(initial); }, [initial]);
  const dirty = JSON.stringify(form) !== baseline.current;
  const registerUnsaved = shell?.registerUnsaved;
  useEffect(() => { registerUnsaved?.(formId, dirty ? 1 : 0, source ? '調達案件の改訂' : '調達案件の登録'); }, [dirty, formId, registerUnsaved, source]);
  useEffect(() => () => registerUnsaved?.(formId, 0, ''), [formId, registerUnsaved]);
  const partnerItems = useMemo(() => toEntityItems(partners), [partners]);
  const disabled = readOnly || saving;

  const update = (group, index, key, value) => setForm((current) => ({...current, [group]: current[group].map((row, i) => (i === index ? {...row, [key]: value} : row))}));
  const add = (group, factory) => setForm((current) => ({...current, [group]: [...current[group], factory()]}));
  const remove = (group, index) => setForm((current) => ({...current, [group]: current[group].filter((_, i) => i !== index)}));
  const changeType = (intakeType) => setForm((current) => ({...current, intakeType, participants: [blankParticipant(intakeType)]}));

  const shares = form.participants.map((row) => parsePercent(row.explicitShare)).filter((parsed) => parsed.ok && parsed.value !== null);
  const shareTotal = shares.reduce((total, parsed) => total + parsed.value, 0);

  async function save(event) {
    event.preventDefault();
    if (disabled) return;
    setError(null);
    const built = intakePayload(form, work.id, territoryOf);
    const otherMissing = form.scopes.map((scope, index) => (scope.territory === OTHER_TERRITORY && !String(scope.territoryOther || '').trim() ? `権利範囲${index + 1}の地域（その他）を入力してください` : null)).filter(Boolean);
    if (!built.ok || otherMissing.length) { setProblems([...(built.ok ? [] : built.errors), ...otherMissing]); return; }
    setProblems([]);
    setSaving(true);
    try {
      const result = await request('/intakes', {method: 'POST', body: JSON.stringify(built.payload)});
      baseline.current = JSON.stringify(form);
      onSaved(source ? `改訂版「${built.payload.caseCode}」を保存しました（前の版は残っています）` : `調達案件「${built.payload.caseCode}」を下書きとして保存しました`, result);
    } catch (cause) {
      setError(translateError(cause));
    } finally {
      setSaving(false);
    }
  }

  return (
    <form className="rt-form" onSubmit={save} noValidate aria-label={source ? '調達案件の改訂' : '調達案件の登録'}>
      <p className="rt-muted">入力の途中でも下書きとして保存できます。保存した版は変えられません。不足を補うときは、前の版を残して改訂版を作ります。</p>
      <fieldset className="rt-section" disabled={disabled}>
        <legend><span className="rt-step">1</span>基本</legend>
        <div className="on-form-grid">
          <FormField label="案件コード" required value={form.caseCode} hint="作品コードと連番で自動で入れています" onChange={(value) => setForm({...form, caseCode: value})} />
          <FormField label="名称" required value={form.title} onChange={(value) => setForm({...form, title: value})} />
          <FormField type="select" label="権利の受け方" required includeBlank={false} value={form.intakeType} options={INTAKE_TYPE_OPTIONS}
            disabled={Boolean(source)} hint={source ? '改訂では変えられません' : undefined} onChange={changeType} />
        </div>
      </fieldset>
      <fieldset className="rt-section" disabled={disabled}>
        <legend><span className="rt-step">2</span>契約書の参照</legend>
        <p className="rt-muted">文書名・保管場所などの文字だけを保存します。ファイルの中身は読み取りません。</p>
        {form.documents.map((row, index) => (
          <div className="rt-row" key={index}>
            <div className="on-form-grid">
              <FormField label="文書名" value={row.title} onChange={(value) => update('documents', index, 'title', value)} />
              <FormField label="参照先" value={row.reference} placeholder="文書管理番号・保管場所など" onChange={(value) => update('documents', index, 'reference', value)} />
              <FormField label="版" value={row.versionLabel} placeholder="例: 第2版・2026年9月締結" onChange={(value) => update('documents', index, 'versionLabel', value)} />
            </div>
            <details>
              <summary>ファイルの照合値を入れる（任意）</summary>
              <FormField label="照合値（64桁）" value={row.contentHash} hint="文書管理で控えた64桁の値。改ざんがないかの確認に使います。空欄でかまいません" onChange={(value) => update('documents', index, 'contentHash', value)} />
            </details>
            <RowActions disabled={disabled} addLabel="文書を追加" removeLabel="この文書を外す" onAdd={() => add('documents', blankDocument)} onRemove={form.documents.length > 1 ? () => remove('documents', index) : null} />
          </div>
        ))}
      </fieldset>
      <fieldset className="rt-section" disabled={disabled}>
        <legend><span className="rt-step">3</span>権利範囲</legend>
        {form.scopes.map((row, index) => (
          <div className="rt-row" key={index}>
            <div className="on-form-grid">
              <FormField type="select" label="媒体" value={row.channel} options={mediaOptions(types, row.channel)} blankLabel="未確認"
                hint="流通区分マスタの流通名から選びます" onChange={(value) => update('scopes', index, 'channel', value)} />
              <FormField type="select" label="地域" value={row.territory} options={territoryOptions()} blankLabel="未確認"
                hint="「国内」「日本国内」などは「日本」にそろえて保存します" onChange={(value) => update('scopes', index, 'territory', value)} />
              {row.territory === OTHER_TERRITORY && (
                <FormField label="地域（その他）" required value={row.territoryOther} onChange={(value) => update('scopes', index, 'territoryOther', value)} />
              )}
              <FormField type="date" label="開始日" value={row.rightsStart} onChange={(value) => update('scopes', index, 'rightsStart', value)} />
              <FormField type="date" label="終了日" value={row.rightsEnd} onChange={(value) => update('scopes', index, 'rightsEnd', value)} />
              <FormField type="select" label="独占" includeBlank={false} value={row.exclusivity} options={EXCLUSIVITY_OPTIONS} onChange={(value) => update('scopes', index, 'exclusivity', value)} />
            </div>
            <RowActions disabled={disabled} addLabel="範囲を追加" removeLabel="この範囲を外す" onAdd={() => add('scopes', blankScope)} onRemove={form.scopes.length > 1 ? () => remove('scopes', index) : null} />
          </div>
        ))}
      </fieldset>
      <fieldset className="rt-section" disabled={disabled}>
        <legend><span className="rt-step">4</span>{participantTitle(form.intakeType)}</legend>
        {form.intakeType === 'committee' && (
          <p className="rt-muted">
            出資額から持分は計算しません。持分は契約書の明示値を入れます。
            持分の合計 {percentText(shareTotal)}
            <span className={`rt-state ${shareTotal === 10000 ? 'is-ok' : 'is-warn'}`}>（{shareTotal === 10000 ? '100%で一致' : '100%になるまで未確認'}）</span>
          </p>
        )}
        {form.participants.map((row, index) => (
          <div className="rt-row" key={index}>
            <div className="on-form-grid">
              {form.intakeType === 'sole_owned'
                ? <FormField label="保有主体" value="当社" readOnly onChange={() => {}} />
                : <EntityPicker label="取引先" items={partnerItems} value={row.partnerId === '' ? null : Number(row.partnerId)} emptyText="取引先がありません"
                    onChange={(value) => update('participants', index, 'partnerId', value === null || value === undefined ? '' : String(value))} />}
              <FormField label="役割" value={row.role} placeholder={form.intakeType === 'committee' ? '例: 幹事・出資' : ''} onChange={(value) => update('participants', index, 'role', value)} />
              {form.intakeType === 'committee' && (
                <>
                  <FormField type="yen" label="出資額" value={row.investmentYen} onChange={(value) => update('participants', index, 'investmentYen', value)} />
                  <PercentField label="持分" value={row.explicitShare} onChange={(value) => update('participants', index, 'explicitShare', value)} />
                </>
              )}
            </div>
            <RowActions disabled={disabled} addLabel="参加者を追加" removeLabel="この参加者を外す" onAdd={() => add('participants', () => blankParticipant(form.intakeType))}
              onRemove={form.participants.length > 1 ? () => remove('participants', index) : null} />
          </div>
        ))}
      </fieldset>
      {problems.length > 0 && (
        <Notice tone="error" title={`${problems.length}か所を確認してください`}>
          <ul className="rt-errors">{problems.map((text) => <li key={text}>{text}</li>)}</ul>
        </Notice>
      )}
      <ProblemNotice error={error} onDismiss={() => setError(null)} />
      <div className="on-form-actions">
        <button type="submit" disabled={disabled}>{saving ? '保存中…' : source ? '改訂版を保存' : '下書きとして保存'}</button>
        <button type="button" className="text" disabled={saving} onClick={onClose}>{dirty ? '入力をやめて閉じる' : '閉じる'}</button>
      </div>
      <p className="rt-muted">この画面は調達情報の不足を見えるようにする試作です。承認、製作委員会の按分、実際の契約書の判定は行いません。</p>
    </form>
  );
}

// 案件1件の詳細。改訂はここ（押した場所）に開く。
function CaseDetail({item, cases, contracts, work, partners, types, request, readOnly, onChanged}) {
  const [revising, setRevising] = useState(false);
  const [contractId, setContractId] = useState('');
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState(null);
  const unlinked = contracts.filter((contract) => !contract.intakeCaseId);
  async function link() {
    setBusy(true);
    setNotice(null);
    try {
      await request(`/intakes/${item.id}/settlement-links`, {method: 'POST', body: JSON.stringify({settlementContractId: Number(contractId)})});
      const contract = contracts.find((row) => String(row.id) === String(contractId));
      onChanged(`「${item.case_code}」を分配契約「${contract?.contract_code || ''}」へ関連付けました`);
    } catch (cause) {
      setNotice({error: translateError(cause)});
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="rp-drill">
      <p className="rp-drill-head">
        <span className={`rt-state ${item.inputComplete ? 'is-ok' : 'is-warn'}`}>{item.inputComplete ? '入力は充足' : '不足・未確認があります'}</span>
        <span>{intakeTypeText(item.intake_type)}・版{item.snapshot_version}・下書き（承認の機能はありません）</span>
      </p>
      {item.missingFields.length > 0 && <ul className="rt-errors rt-muted">{item.missingFields.map((value) => <li key={value}>{value}</li>)}</ul>}
      <div className="three">
        <section>
          <h4>契約書の参照</h4>
          {item.documents.length ? item.documents.map((row) => <p key={row.id}>{row.title || '名称未確認'}<small>{row.reference || '参照先未確認'}／{row.version_label || '版未確認'}</small></p>) : <p className="rt-muted">未登録</p>}
        </section>
        <section>
          <h4>権利範囲</h4>
          {item.scopes.length ? item.scopes.map((row) => (
            <p key={row.id}>{row.channel || '媒体未確認'}／{row.territory ? territoryLabel(row.territory) : '地域未確認'}
              <small>{row.rights_start || '開始未確認'}〜{row.rights_end || '終了未確認'}／{exclusivityText(row.exclusivity)}</small></p>
          )) : <p className="rt-muted">未登録</p>}
        </section>
        <section>
          <h4>{participantTitle(item.intake_type)}</h4>
          {item.participants.length ? item.participants.map((row) => (
            <p key={row.id}>{row.party_kind === 'current_org' ? '当社' : row.partner_name || '取引先未確認'}
              <small>{row.role || '役割未確認'}{item.intake_type === 'committee' ? `／出資 ${yen(row.investment_yen)}／持分 ${percentText(row.explicit_share_bps)}` : ''}</small></p>
          )) : <p className="rt-muted">未登録</p>}
        </section>
      </div>
      {item.settlementLinks.length
        ? <p><span className="rt-state is-ok">分配契約に関連付け済み</span>：{item.settlementLinks.map((row) => `${row.contract_code}｜${row.contract_title}`).join('、')}</p>
        : (
          <div className="rt-actions">
            <FormField type="select" label="既存の分配契約へ関連付ける" value={contractId} blankLabel={unlinked.length ? '選んでください' : '関連付けできる契約はありません'}
              options={unlinked.map((contract) => ({value: String(contract.id), label: `${contract.contract_code}｜${contract.title}`}))} disabled={readOnly || busy} onChange={setContractId} />
            <button type="button" disabled={readOnly || busy || !contractId} onClick={link}>{busy ? '保存中…' : '関連付ける'}</button>
          </div>
        )}
      {notice?.error && <ProblemNotice error={notice.error} onDismiss={() => setNotice(null)} />}
      <div className="rt-actions">
        <button type="button" className={revising ? '' : 'secondary'} aria-expanded={revising} disabled={readOnly} onClick={() => setRevising((value) => !value)}>
          {revising ? '改訂の入力を閉じる' : T.revise}
        </button>
        {item.intake_type === 'committee' && <span className="rt-muted">製作委員会の条件と期間報告は「製作委員会」画面で作ります。</span>}
      </div>
      {revising && (
        <div className="rt-inline">
          <h4>「{item.case_code}」の改訂版（版{item.snapshot_version + 1}）</h4>
          <IntakeForm work={work} cases={cases} source={item} partners={partners} types={types} request={request} readOnly={readOnly}
            onClose={() => setRevising(false)} onSaved={(message) => { setRevising(false); onChanged(message); }} />
        </div>
      )}
    </div>
  );
}

const COLUMNS = [
  {key: 'case_code', label: '案件コード', type: 'code', sticky: true},
  {key: 'title', label: '名称', type: 'text', wrap: true},
  {key: 'typeText', label: '権利の受け方', type: 'text'},
  {key: 'snapshot_version', label: '版', type: 'int', total: 'none'},
  {key: 'readiness', label: '入力の状況', type: 'text', render: (row) => <span className={`rt-state ${row.readinessOk ? 'is-ok' : 'is-warn'}`}>{row.readiness}</span>},
  {key: 'sourceText', label: '改訂元', type: 'text'},
  {key: 'linksText', label: '分配契約', type: 'text', wrap: true},
  {key: 'statusText', label: '状態', type: 'text'},
  {key: 'created_at', label: '登録日時', type: 'datetime'},
];

export default function RightsIntake({data, request}) {
  const shell = useShell();
  const req = request || shell.request;
  const readOnly = Boolean(shell.readOnly);
  const workId = data.selectedWorkId;
  const found = data.selectedWork || data.works?.find((item) => item.id === workId) || null;
  const work = useMemo(() => found || {id: workId}, [found, workId]);
  const [state, setState] = useState({workId: null, cases: [], contracts: [], note: ''});
  const [types, setTypes] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [revision, setRevision] = useState(0);
  const [creating, setCreating] = useState(false);
  const [notice, setNotice] = useState('');
  const requestId = useRef(0);
  useEffect(() => {
    let live = true;
    req('/distribution-types').then((body) => { if (live) setTypes(body.rows || []); }).catch(() => { /* 読めないときは基本の媒体だけを出す */ });
    return () => { live = false; };
  }, [req]);
  useEffect(() => {
    if (!workId) return undefined;
    const id = ++requestId.current;
    setLoading(true);
    setError(null);
    if (state.workId !== workId) { setCreating(false); setNotice(''); }
    Promise.all([req(`/intakes?workId=${workId}`), req(`/settlement/contracts?workId=${workId}`)])
      .then(([intakes, contracts]) => { if (id === requestId.current) setState({workId, cases: intakes.cases, contracts: contracts.contracts, note: intakes.note}); })
      .catch((cause) => { if (id === requestId.current) setError(cause); })
      .finally(() => { if (id === requestId.current) setLoading(false); });
    return () => { requestId.current += 1; };
  }, [workId, revision]); // eslint-disable-line react-hooks/exhaustive-deps
  const changed = (message) => { if (message) setNotice(message); setRevision((value) => value + 1); };
  const rows = useMemo(() => intakeRows(state.workId === workId ? state.cases : []), [state, workId]);
  const partners = data.partners || [];

  if (!workId) return <Notice tone="info" message="作品を選ぶと、権利の調達案件を表示します。" />;
  const cases = state.workId === workId ? state.cases : [];
  return (
    <div className="stack rt-page">
      <section className="card rt-intro">
        <p className="rt-eyebrow">{T.eyebrow}</p>
        <h2>{T.title}</h2>
        <p>{T.lead}</p>
      </section>
      <ProblemNotice error={error} title="調達案件を読み込めませんでした" onRetry={() => changed()} />
      <section className="card rp-report" aria-label={T.list}>
        <div className="rt-head">
          <div>
            <h2>{T.list}（{cases.length}件）</h2>
            <p className="rt-muted">行を押すと、保存した内容・不足している項目・分配契約との関連が開きます。既存の分配契約は自動では関連付けません。</p>
          </div>
          <button type="button" className={creating ? '' : 'secondary'} aria-expanded={creating} disabled={readOnly} onClick={() => setCreating((value) => !value)}>
            {creating ? '登録の入力を閉じる' : T.register}
          </button>
        </div>
        {readOnly && <p className="rt-muted">閲覧専用の表示のため登録できません。</p>}
        {notice && <Notice tone="ok" message={notice} onDismiss={() => setNotice('')} />}
        {creating && (
          <div className="rt-inline">
            <h4>調達案件を登録</h4>
            <IntakeForm work={work} cases={cases} source={null} partners={partners} types={types} request={req} readOnly={readOnly}
              onClose={() => setCreating(false)} onSaved={(message) => { setCreating(false); changed(message); }} />
          </div>
        )}
        <DataGrid columns={COLUMNS} rows={rows} rowKey="id" persistKey="rights-intake" ariaLabel={T.list}
          emptyText={loading ? '読み込んでいます…' : 'この作品の調達案件はまだありません。「＋調達案件を登録」から入力します'}
          exportSpec={{name: '調達案件', title: '権利の調達案件', conditions: [['作品', work.title || '']]}}
          renderDetail={(row) => (
            <CaseDetail item={row} cases={cases} contracts={state.contracts} work={work} partners={partners} types={types} request={req} readOnly={readOnly} onChanged={changed} />
          )} />
        {state.note && <p className="rt-muted">{japaneseMessage(state.note)}</p>}
      </section>
    </div>
  );
}
