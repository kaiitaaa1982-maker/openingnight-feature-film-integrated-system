// MG契約・台帳。受取MG（販売先）と支払MG（権利元）を別々に扱う（合算しない）。
// 契約の一覧に累計実充当・未消化残高・到達率、当期報告は消化対象と残高から実充当・超過報告の候補を入れ、
// 台帳は契約・商品・計上月で絞って累計と残高を積み上げ、Excelで出力・取込（テンプレート→プレビュー→登録）する。
// 台帳の行と契約の版は変更・削除できない（直すときは訂正版・新しい版を登録する）ため、登録の前に画面内で内容を確かめる。
// 画面の論理は mg-ledger-import.mjs の純関数（test/mg-ledger-import.test.mjs）。
import React, {useCallback, useEffect, useId, useMemo, useRef, useState} from 'react';
import {useShell} from './shell/context.mjs';
import {DataGrid} from './ui/DataGrid.jsx';
import {FormField} from './ui/FormField.jsx';
import {Notice} from './ui/Notice.jsx';
import {Tabs} from './ui/Tabs.jsx';
import {yen, int, rate, month as monthText, dateJst, dateTimeJst} from './ui/format.mjs';
import {parseYen, formatNumberInput} from './ui/parse-input.mjs';
import {decodeXlsx} from './xlsx.mjs';
import {decodeText} from './import/text-decode.mjs';
import {downloadReportXlsx, reportBaseName} from './xlsx-report.mjs';
import {mgPeriods} from './mg.mjs';
import {apiDbError, isConstraintKind} from './data-platform/db-errors.mjs';
import {
  MG_AMOUNT_LABELS, MG_DIRECTION_LABELS, MG_DIRECTION_SHORT, MG_MODE_LABELS, MG_STATUS_LABELS, contractProgress, progressTotals, latestVersion,
  ledgerView, priorAppliedYen, mgCandidate, fillAmounts, candidateDifference, differenceText, sumMismatch, nextReportPeriod, derivePhases, emptyPhase,
  emptyContractForm, contractFormFromVersion, evaluationState, evaluationGapText, buildContractPayload, buildReportPayload, workbookToMgImport,
  sheetToMgImport, splitCsv, mgTemplateSheets, signedYen,
} from './mg-ledger-import.mjs';
import './mg.css';

const DIRECTION_TABS = [{id: 'incoming', label: MG_DIRECTION_LABELS.incoming}, {id: 'outgoing', label: MG_DIRECTION_LABELS.outgoing}];
const L = MG_AMOUNT_LABELS;
const todayJst = () => new Date().toLocaleDateString('sv-SE', {timeZone: 'Asia/Tokyo'});
const MONTH_OFFSETS = Array.from({length: 25}, (_, n) => ({value: String(n), label: n === 0 ? '締めの月' : `締めの${n}か月後`}));
const DAYS = Array.from({length: 31}, (_, i) => ({value: String(i + 1), label: i === 30 ? '月末（31日）' : `${i + 1}日`}));
const CLOSE_DAYS = [{value: 'eom', label: '月末'}, ...Array.from({length: 30}, (_, i) => ({value: String(i + 1), label: `${i + 1}日`}))];
const INTERVALS = [{value: '1', label: '毎月'}, {value: '3', label: '四半期（3か月）'}, {value: '6', label: '半年'}, {value: '12', label: '毎年'}];
const MODE_OPTIONS = Object.entries(MG_MODE_LABELS).map(([value, label]) => ({value, label}));

// 画面の状態を URL に残す（外枠が無いときは手元の状態）。
function useViewParam(shell, key, fallback) {
  const [local, setLocal] = useState(fallback);
  const value = shell.isFallback ? local : shell.getParam(key, null) ?? fallback;
  const set = useCallback((next) => {
    if (shell.isFallback) setLocal(next ?? fallback);
    else shell.setParam(key, next === fallback || next === '' ? null : next, {replace: true});
  }, [shell, key, fallback]);
  return [value, set];
}

// DB制約の違反（API が応答に載せた共通のエラーの種類。src/data-platform/db-errors.mjs）を、利用者が直せる日本語にする（技術情報は折りたたみへ）。
function errorNotice(error, {unique = '同じ内容が登録済みです。再読込して確認してください'} = {}) {
  const kind = apiDbError(error)?.kind;
  if (!isConstraintKind(kind)) return {tone: 'error', error};
  const message = kind === 'unique' ? unique : kind === 'foreign_key' ? '選んだ商品・相手先・条件版が見つかりません。画面を再読込して選び直してください' : '入力の組み合わせを確認してください';
  return {tone: 'error', message, technical: String(error?.message || '')};
}

function NoticeView({notice, onDismiss}) {
  if (!notice) return null;
  return <Notice tone={notice.tone} title={notice.title} message={notice.message} error={notice.error} technical={notice.technical} details={notice.details} onDismiss={onDismiss} actions={notice.actions} />;
}

function ProgressBar({progress, compact = false}) {
  const text = progress.rate === null ? '到達率は保証額0円のため算出しません' : `到達率 ${rate(progress.rate)}`;
  return (
    <span className={`mg-progress is-${progress.status.code}`}>
      <span className="mg-progress-track" role="img" aria-label={`${progress.status.label}・${text}`}>
        <span className="mg-progress-fill" style={{width: `${progress.barPercent}%`}} />
      </span>
      <span className="mg-progress-text">
        <strong>{progress.status.label}</strong>{compact ? '' : text}{progress.exceedYen > 0 ? `（保証額を${yen(progress.exceedYen)}超過）` : ''}
      </span>
    </span>
  );
}

function StateBadge({state, label}) {
  return <span className={`mg-state is-${state}`}>{label}</span>;
}

// 取り消せない登録の前に、画面内で内容を確かめる（2段確認）。
function ConfirmPanel({title, items, note, busy, readOnly, confirmLabel, onConfirm, onBack}) {
  return (
    <div className="mg-confirm" role="region" aria-label={title}>
      <strong>{title}</strong>
      <dl>{items.filter(Boolean).map(([k, v]) => <React.Fragment key={k}><dt>{k}</dt><dd>{v}</dd></React.Fragment>)}</dl>
      {note && <p className="mg-muted">{note}</p>}
      <div className="on-form-actions">
        <button type="button" disabled={busy || readOnly} onClick={onConfirm}>{busy ? '登録中…' : confirmLabel}</button>
        <button type="button" className="secondary" disabled={busy} onClick={onBack}>戻って直す</button>
      </div>
      {readOnly && <p className="mg-muted">プレビューでは登録できません。</p>}
    </div>
  );
}

// ---- 契約と条件の版 ----

function ContractForm({direction, parties, products, initial, editing, request, readOnly, onSaved, onCancel}) {
  const shell = useShell();
  const [form, setForm] = useState(initial);
  const [errors, setErrors] = useState({});
  const [search, setSearch] = useState('');
  const [step, setStep] = useState('edit');
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState(null);
  const [payload, setPayload] = useState(null);
  const unsavedId = `mg-contract-${editing ? editing.id : 'new'}`;
  const dirty = JSON.stringify(form) !== JSON.stringify(initial);
  useEffect(() => {
    shell.registerUnsaved?.(unsavedId, dirty || step === 'confirm' ? 1 : 0, editing ? 'MG条件の改訂' : 'MG契約の登録');
    return () => shell.registerUnsaved?.(unsavedId, 0);
  }, [dirty, step]); // eslint-disable-line react-hooks/exhaustive-deps

  const patch = (key, value) => { setForm((f) => ({...f, [key]: value})); setStep('edit'); };
  const patchPhase = (index, key, value) => patch('phases', form.phases.map((p, n) => (n === index ? {...p, [key]: value} : p)));
  const evaluation = evaluationState(form);
  const phases = derivePhases({startsOn: form.startsOn, endsOn: form.endsOn}, form.phases);
  let schedule = null;
  if (phases.some((p) => !p.startsOn || !p.endsOn)) schedule = {ok: null, text: '契約期間と各期間の終了日を入れると、締め・報告・支払の日程を計算します'};
  else try {
    const list = mgPeriods(phases.map((p) => ({...p, intervalMonths: Number(p.intervalMonths), reportOffsetMonths: Number(p.reportOffsetMonths), reportDay: Number(p.reportDay), payOffsetMonths: Number(p.payOffsetMonths), payDay: Number(p.payDay)})));
    schedule = {ok: true, text: `締めは${list.length}回（最初 ${dateJst(list[0].closeOn)}・最後 ${dateJst(list.at(-1).closeOn)}）。最初の報告予定 ${dateJst(list[0].reportOn)}、支払予定 ${dateJst(list[0].payOn)}`};
  } catch (error) {
    schedule = {ok: false, text: `日程を確認してください: ${error.message}`};
  }
  const shown = products.filter((p) => `${p.sku} ${p.name}`.toLowerCase().includes(search.toLowerCase()) || form.products.some((x) => Number(x.productId) === Number(p.id)));
  const partyLabel = direction === 'incoming' ? '販売先' : '仕入先・権利元';

  function review() {
    const built = buildContractPayload(form, {direction, editing});
    if (!built.ok) {
      setErrors(built.errors);
      setNotice({tone: 'warn', message: `入力を確認してください（${Object.keys(built.errors).length}項目）`});
      return;
    }
    setErrors({});
    setNotice(null);
    setPayload(built.body);
    setStep('confirm');
  }
  async function save() {
    if (busy || readOnly) return;
    setBusy(true);
    setNotice(null);
    try {
      await request(editing ? `/mg/contracts/${direction}/${editing.id}/versions` : '/mg/contracts', {method: 'POST', body: JSON.stringify(payload)});
      onSaved(editing ? `条件の第${editing.baseVersion + 1}版を登録しました。前の版はそのまま残っています。` : `契約「${payload.code}｜${payload.title}」を登録しました。`);
    } catch (error) {
      setNotice(errorNotice(error, {unique: editing ? '他の人が先に条件を改訂しました。画面を再読込して最新の版から改訂してください' : '同じ契約コードの契約が登録済みです。別のコードにしてください'}));
      setStep('edit');
    } finally {
      setBusy(false);
    }
  }

  const partyName = parties.find((p) => String(p.id) === String(form.partyId))?.name;
  return (
    <section className="mg-form" aria-label={editing ? '条件の改訂' : 'MG契約の登録'}>
      <header className="mg-section-head">
        <div>
          <h3>{editing ? `条件を改訂する（第${editing.baseVersion + 1}版を作る）` : `${MG_DIRECTION_SHORT[direction]}の契約を登録する`}</h3>
          <p className="mg-muted">{editing ? '前回の版の内容を既定値にしています。変わった項目と改訂の理由だけを直してください。' : '契約と最初の条件（第1版）を登録します。登録後は変更・削除できず、改訂は新しい版で行います。'}</p>
        </div>
        <button type="button" className="text" onClick={onCancel}>閉じる</button>
      </header>
      <NoticeView notice={notice} onDismiss={() => setNotice(null)} />
      <div className="on-form-grid">
        {!editing && (
          <>
            <FormField label="契約コード" required value={form.code} error={errors.code} onChange={(v) => patch('code', v)} placeholder="例: MG-2026-01" />
            <FormField label="契約名" required value={form.title} error={errors.title} onChange={(v) => patch('title', v)} />
            <FormField type="select" label={partyLabel} required value={String(form.partyId ?? '')} error={errors.partyId} options={parties.map((p) => ({value: String(p.id), label: `${p.code}｜${p.name}`}))}
              onChange={(v) => patch('partyId', v)} hint={parties.length ? undefined : direction === 'outgoing' ? '先に下の「仕入先・権利元」を登録してください' : '取引先がありません'} />
            <FormField type="date" label="契約締結日" required value={form.contractDate} error={errors.contractDate} onChange={(v) => patch('contractDate', v)} hint="管理用。計上月の基準には使いません" />
            <FormField label="契約資料の参照" required value={form.contractSourceReference} error={errors.contractSourceReference} onChange={(v) => patch('contractSourceReference', v)} placeholder="例: 契約書のファイル名" />
          </>
        )}
        <FormField type="yen" label="MG保証額（税抜）" required value={form.mgAmountYen} error={errors.mgAmountYen} allowNegative={false} onChange={(v) => patch('mgAmountYen', v)} />
        <FormField type="date" label="契約開始日" required value={form.startsOn} error={errors.startsOn} onChange={(v) => patch('startsOn', v)} />
        <FormField type="date" label="契約終了日" required value={form.endsOn} error={errors.endsOn} onChange={(v) => patch('endsOn', v)} />
        <FormField type="select" label="回収方式" required includeBlank={false} value={form.mode} options={MODE_OPTIONS} onChange={(v) => patch('mode', v)} />
        <FormField label={editing ? '改訂の理由' : '登録の理由'} required value={form.reason} error={errors.reason} onChange={(v) => patch('reason', v)} />
        <FormField label="条件の根拠資料" required value={form.sourceReference} error={errors.sourceReference} onChange={(v) => patch('sourceReference', v)} hint={editing ? '前回の版の根拠を既定にしています。新しい覚書などがあれば書き換えてください' : undefined} />
      </div>
      {form.mode === 'special' && (
        <label className="mg-check">
          <input type="checkbox" checked={form.specialUnverified} onChange={(e) => patch('specialUnverified', e.target.checked)} />
          特殊条件の計算式は未確認として登録する（残高・候補は参考値になります）
        </label>
      )}
      {errors.specialUnverified && <p className="on-field-error">{errors.specialUnverified}</p>}

      <fieldset>
        <legend>対象商品と評価額</legend>
        <p className="mg-muted">{form.mode === 'single' ? '単品契約は商品を1件だけ選びます。評価額はMG保証額と同じです（入力不要）。' : '商品ごとの評価額の合計をMG保証額にそろえます。分配率は別の契約条件です。'}</p>
        <FormField type="search" label="商品を探す" value={search} onChange={setSearch} placeholder="商品コード・商品名" />
        <div className="mg-products">
          {shown.map((p) => {
            const index = form.products.findIndex((x) => Number(x.productId) === Number(p.id));
            const row = form.products[index];
            return (
              <div className="mg-product" key={p.id}>
                <label className="mg-check">
                  <input type="checkbox" checked={Boolean(row)} onChange={(e) => patch('products', e.target.checked ? [...form.products, {productId: p.id, evaluationYen: ''}] : form.products.filter((x) => Number(x.productId) !== Number(p.id)))} />
                  {p.sku}｜{p.name}
                </label>
                {row && (evaluation.derived
                  ? <span className="mg-derived">評価額 {evaluation.amountYen === null ? 'MG保証額と同じ' : yen(evaluation.amountYen)}（MG保証額と同じ）</span>
                  : (
                    <div className="mg-eval">
                      <FormField type="yen" label={`${p.sku}の評価額`} value={row.evaluationYen} allowNegative={false} onChange={(v) => patch('products', form.products.map((x, n) => (n === index ? {...x, evaluationYen: v} : x)))} />
                      {evaluation.differenceYen > 0 && (
                        <button type="button" className="text" onClick={() => {
                          const current = parseYen(row.evaluationYen, {allowNegative: false});
                          const next = (current.ok && current.value ? current.value : 0) + evaluation.differenceYen;
                          patch('products', form.products.map((x, n) => (n === index ? {...x, evaluationYen: formatNumberInput(next)} : x)));
                        }}>残り{yen(evaluation.differenceYen)}をこの商品に入れる</button>
                      )}
                    </div>
                  ))}
              </div>
            );
          })}
          {!shown.length && <p className="mg-muted">該当する商品がありません（作品に配賦されていない商品と、財務権限のない商品は選べません）。</p>}
        </div>
        <p className={`mg-sum${form.products.length > 1 && evaluation.differenceYen ? ' is-gap' : ''}`}>
          選択 {form.products.length}商品・評価額の合計 {yen(evaluation.totalYen)}
          {form.products.length > 1 && evaluation.amountYen !== null && `（${evaluationGapText(evaluation.differenceYen)}）`}
        </p>
        {errors.products && <p className="on-field-error">{errors.products}</p>}
      </fieldset>

      <fieldset>
        <legend>締め・報告・支払の日程</legend>
        <p className="mg-muted">期間の開始日は自動で決まります（最初は契約開始日、次は前の期間の翌日。最後の期間は契約終了日まで）。休日の補正はしません。</p>
        {phases.map((phase, index) => (
          <div className="mg-phase" key={index}>
            <h4>期間{index + 1}: {phase.startsOn ? dateJst(phase.startsOn) : '（開始日未定）'}〜{index === phases.length - 1 ? `${phase.endsOn ? dateJst(phase.endsOn) : '（契約終了日）'}（契約終了日まで）` : ''}</h4>
            <div className="on-form-grid">
              {index < phases.length - 1 && <FormField type="date" label="この期間の終了日" required value={form.phases[index].endsOn} error={errors[`phase${index}`]} onChange={(v) => patchPhase(index, 'endsOn', v)} />}
              <FormField type="select" label="締めの周期" includeBlank={false} value={String(phase.intervalMonths)} options={INTERVALS} onChange={(v) => patchPhase(index, 'intervalMonths', Number(v))} />
              <FormField type="select" label="通常の締め日" includeBlank={false} value={String(phase.closeDay)} options={CLOSE_DAYS} onChange={(v) => patchPhase(index, 'closeDay', v)} />
              <FormField type="date" label="初回の締め日" value={form.phases[index].firstCloseOn} onChange={(v) => patchPhase(index, 'firstCloseOn', v)} hint={form.phases[index].firstCloseOn ? undefined : `空欄なら ${phase.firstCloseOn ? dateJst(phase.firstCloseOn) : '開始日の月の締め日'}`} />
              <FormField type="select" label="報告予定（月）" includeBlank={false} value={String(phase.reportOffsetMonths)} options={MONTH_OFFSETS} onChange={(v) => patchPhase(index, 'reportOffsetMonths', Number(v))} />
              <FormField type="select" label="報告予定（日）" includeBlank={false} value={String(phase.reportDay)} options={DAYS} onChange={(v) => patchPhase(index, 'reportDay', Number(v))} />
              <FormField type="select" label="支払予定（月）" includeBlank={false} value={String(phase.payOffsetMonths)} options={MONTH_OFFSETS} onChange={(v) => patchPhase(index, 'payOffsetMonths', Number(v))} />
              <FormField type="select" label="支払予定（日）" includeBlank={false} value={String(phase.payDay)} options={DAYS} onChange={(v) => patchPhase(index, 'payDay', Number(v))} />
            </div>
            {errors[`phase${index}`] && index === phases.length - 1 && <p className="on-field-error">{errors[`phase${index}`]}</p>}
            {form.phases.length > 1 && <button type="button" className="text" onClick={() => patch('phases', form.phases.filter((_, n) => n !== index))}>この期間を外す</button>}
          </div>
        ))}
        <button type="button" className="secondary" onClick={() => patch('phases', [...form.phases.slice(0, -1), {...form.phases.at(-1), endsOn: ''}, emptyPhase()])}>期間を分ける（条件が途中で変わるとき）</button>
        <p className={`mg-schedule${schedule.ok === false ? ' is-bad' : ''}`} role="status">{schedule.text}</p>
      </fieldset>

      {step === 'edit' ? (
        <div className="on-form-actions">
          <button type="button" onClick={review} disabled={readOnly}>内容を確認する</button>
          <button type="button" className="secondary" onClick={onCancel}>閉じる</button>
        </div>
      ) : (
        <ConfirmPanel title={editing ? `第${editing.baseVersion + 1}版として登録する内容` : '登録する契約の内容'} busy={busy} readOnly={readOnly}
          confirmLabel={editing ? 'この内容で新しい版を作る' : 'この内容で登録する'} onConfirm={save} onBack={() => setStep('edit')}
          note="登録した契約と条件の版は変更・削除できません。直すときは新しい版を作ります。"
          items={[
            !editing && ['契約', `${payload.code}｜${payload.title}`], !editing && [partyLabel, partyName || '未選択'],
            ['MG保証額', yen(payload.mgAmountYen)], ['契約期間', `${dateJst(payload.startsOn)}〜${dateJst(payload.endsOn)}`], ['回収方式', MG_MODE_LABELS[payload.mode]],
            ['商品と評価額', payload.products.map((p) => `${products.find((x) => Number(x.id) === p.productId)?.sku || '商品'} ${yen(p.evaluationYen)}`).join('、')],
            ['日程', `${payload.phases.length}期間。${schedule.ok ? schedule.text : ''}`], [editing ? '改訂の理由' : '登録の理由', payload.reason], ['条件の根拠資料', payload.sourceReference],
          ]} />
      )}
    </section>
  );
}

// ---- 当期報告 ----

function blankReport(contract, correction) {
  const latest = latestVersion(contract);
  const base = {
    termVersionId: String(latest?.id ?? ''), productId: String(latest?.products?.[0]?.product_id ?? ''), periodFrom: '', periodTo: '',
    accountingMonth: todayJst().slice(0, 7), reportReceivedOn: '', sourceReference: '', reportedEligibleYen: '', appliedRecoupYen: '', reportedOverageYen: '',
    recognizedYen: '', status: 'unverified', acknowledgement: false, confirmationReason: '', differenceReason: '', reversesEntryId: null,
  };
  if (!correction) return base;
  return {
    ...base, termVersionId: String(correction.termVersionId), productId: String(correction.productId), periodFrom: correction.periodFrom, periodTo: correction.periodTo,
    accountingMonth: correction.accountingMonth, reportReceivedOn: correction.reportReceivedOn || '', reportedEligibleYen: formatNumberInput(correction.eligible),
    recognizedYen: formatNumberInput(correction.recognized), reversesEntryId: correction.id,
  };
}

function ReportEntry({contract, direction, ledger, request, readOnly, correction, onCancelCorrection, onSaved}) {
  const shell = useShell();
  const [report, setReport] = useState(() => blankReport(contract, correction));
  const [touched, setTouched] = useState({applied: false, overage: false});
  const [periods, setPeriods] = useState([]);
  const [periodState, setPeriodState] = useState({loading: false, error: null});
  const [picked, setPicked] = useState(Boolean(correction));
  const [errors, setErrors] = useState({});
  const [step, setStep] = useState('edit');
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState(null);
  const [payload, setPayload] = useState(null);

  const version = contract.versions.find((v) => Number(v.id) === Number(report.termVersionId)) || latestVersion(contract);
  const product = version?.products?.find((p) => Number(p.product_id) === Number(report.productId));
  const special = version?.mode === 'special';
  const patch = (key, value) => { setReport((r) => ({...r, [key]: value})); setStep('edit'); };

  useEffect(() => {
    if (!version) return undefined;
    let live = true;
    setPeriodState({loading: true, error: null});
    request(`/mg/periods?termVersionId=${version.id}`)
      .then((body) => { if (live) { setPeriods(body.periods || []); setPeriodState({loading: false, error: null}); } })
      .catch((error) => { if (live) { setPeriods([]); setPeriodState({loading: false, error}); } });
    return () => { live = false; };
  }, [version?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  // 期間を選んでいなければ、まだ報告のない最初の締め期間を既定にする
  useEffect(() => {
    if (picked || !periods.length) return;
    const next = nextReportPeriod(periods, ledger, {termVersionId: version?.id, productId: report.productId}) || periods.at(-1);
    setReport((r) => ({...r, periodFrom: next.periodFrom, periodTo: next.periodTo}));
  }, [periods, report.productId, picked, ledger.length]); // eslint-disable-line react-hooks/exhaustive-deps

  const eligible = parseYen(report.reportedEligibleYen, {allowNegative: false});
  const prior = priorAppliedYen(ledger, {direction, contractId: contract.id, excludeEntryIds: correction ? [correction.id] : []});
  const candidate = eligible.ok && eligible.value !== null ? mgCandidate({eligibleYen: eligible.value, guaranteeYen: version?.mg_amount_yen, priorAppliedYen: prior}) : null;
  // 両方空欄なら候補、片方を書き換えたらもう片方は消化対象の残り
  const typed = (key, on) => {
    if (!on) return null;
    const parsed = parseYen(report[key], {allowNegative: false});
    return parsed.ok ? parsed.value : report[key];
  };
  const fill = fillAmounts({eligibleYen: eligible.ok ? eligible.value : null, appliedRecoupYen: typed('appliedRecoupYen', touched.applied), reportedOverageYen: typed('reportedOverageYen', touched.overage), candidate});
  const autoText = (value) => (value === null || value === undefined || value === '' ? '' : formatNumberInput(value));
  const shownApplied = touched.applied ? report.appliedRecoupYen : autoText(fill.appliedRecoupYen);
  const shownOverage = touched.overage ? report.reportedOverageYen : autoText(fill.reportedOverageYen);
  const amounts = Object.fromEntries([['appliedRecoupYen', shownApplied], ['reportedOverageYen', shownOverage]].map(([key, text]) => {
    const parsed = parseYen(text, {allowNegative: false});
    return [key, parsed.ok ? parsed.value : null];
  }));
  const difference = candidateDifference(candidate, amounts);
  const needsReason = Boolean(difference?.differs) && !special;
  // 候補と同じになったら、以前に書いた差の理由は送らない
  const effective = {...report, appliedRecoupYen: shownApplied, reportedOverageYen: shownOverage, differenceReason: needsReason ? report.differenceReason : ''};
  const mismatch = sumMismatch({reportedEligibleYen: eligible.ok ? eligible.value : null, ...amounts});
  const remainingAfter = candidate && amounts.appliedRecoupYen !== null ? Math.max(0, candidate.remainingBeforeYen - amounts.appliedRecoupYen) : null;
  const doneKeys = new Set(ledger.filter((r) => Number(r.term_version_id) === Number(version?.id) && Number(r.product_id) === Number(report.productId) && !Number(r.isSuperseded)).map((r) => `${r.period_from}|${r.period_to}`));
  const periodIndex = periods.findIndex((p) => p.periodFrom === report.periodFrom && p.periodTo === report.periodTo);

  const dirty = Boolean(correction) || Boolean(report.reportedEligibleYen || report.sourceReference || report.recognizedYen || touched.applied || touched.overage);
  useEffect(() => {
    shell.registerUnsaved?.('mg-report', dirty || step === 'confirm' ? 1 : 0, correction ? 'MG報告の訂正版の入力' : 'MG当期報告の入力');
    return () => shell.registerUnsaved?.('mg-report', 0);
  }, [dirty, step]); // eslint-disable-line react-hooks/exhaustive-deps

  function review() {
    const built = buildReportPayload(effective, {candidate, special});
    const nextErrors = built.ok ? {} : {...built.errors};
    const source = String(report.sourceReference || '').trim();
    if (source && ledger.some((r) => Number(r.term_version_id) === Number(version?.id) && Number(r.product_id) === Number(report.productId) && r.source_reference === source)) {
      nextErrors.sourceReference = 'この条件版・商品で、同じ報告資料参照の報告が登録済みです。訂正するときは台帳の行から「訂正版を入力」を選んでください';
    }
    if (Object.keys(nextErrors).length) {
      setErrors(nextErrors);
      setNotice({tone: 'warn', message: `入力を確認してください（${Object.keys(nextErrors).length}項目）`});
      return;
    }
    setErrors({});
    setNotice(null);
    setPayload(built.body);
    setStep('confirm');
  }
  async function save() {
    if (busy || readOnly) return;
    setBusy(true);
    setNotice(null);
    try {
      await request('/mg/ledger', {method: 'POST', body: JSON.stringify(payload)});
      onSaved(`${correction ? '訂正版' : '当期の報告'}を登録しました（${monthText(payload.accountingMonth)}計上・${L.appliedRecoupYen} ${yen(payload.appliedRecoupYen)}）。${correction ? '元の報告は訂正前として残し、集計から外しました。' : ''}売上・費用への自動転記はしていません。`);
    } catch (error) {
      setNotice(errorNotice(error, {unique: 'この条件版・商品で、同じ報告資料参照の報告が登録済みです。資料参照を確かめてください'}));
      setStep('edit');
    } finally {
      setBusy(false);
    }
  }

  const amountField = (key, shown, touchKey, candidateValue) => (
    <div className="mg-amount">
      <FormField type="yen" label={L[key]} value={shown} allowNegative={false} error={errors[key]}
        onChange={(v) => { setTouched((t) => ({...t, [touchKey]: true})); patch(key, v); }}
        hint={!touched[touchKey]
          ? (fill.filled.length === 1 && fill.filled[0] === key ? `${L.reportedEligibleYen}の残りを入れています` : candidate ? '候補を入れています（報告書と違えば書き換えてください）' : `${L.reportedEligibleYen}を入れると候補が入ります`)
          : candidateValue !== null && candidateValue !== undefined ? `候補 ${yen(candidateValue)}` : undefined} />
      {touched[touchKey] && candidate && <button type="button" className="text" onClick={() => { setTouched((t) => ({...t, [touchKey]: false})); patch(key, ''); }}>候補に戻す</button>}
    </div>
  );

  return (
    <section className="mg-report" aria-label={correction ? '訂正版の入力' : '当期の報告'}>
      <header className="mg-section-head">
        <div>
          <h3>{correction ? '訂正版を入力する' : '当期の報告を登録する'}</h3>
          <p className="mg-muted">{correction
            ? `訂正する報告: ${correction.sourceReference}（${monthText(correction.accountingMonth)}計上・${L.reportedEligibleYen} ${yen(correction.eligible)}・${L.appliedRecoupYen} ${yen(correction.applied)}）。元の報告は消さずに残します。`
            : '金額は当期分を入れます（累計ではありません）。「手動確認済み」は入力値を報告原本と照合した印で、計上方針の承認や仕訳の確定ではありません。'}</p>
        </div>
        {correction && <button type="button" className="text" onClick={onCancelCorrection}>訂正をやめる</button>}
      </header>
      <NoticeView notice={notice} onDismiss={() => setNotice(null)} />
      <div className="mg-report-grid">
        <div className="on-form-grid">
          {contract.versions.length > 1
            ? <FormField type="select" label="条件版" includeBlank={false} disabled={Boolean(correction)} value={String(report.termVersionId)}
                options={contract.versions.map((v) => ({value: String(v.id), label: `第${v.version}版（${dateJst(v.starts_on)}〜${dateJst(v.ends_on)}・保証額 ${yen(v.mg_amount_yen)}）`}))}
                onChange={(v) => { const next = contract.versions.find((x) => String(x.id) === v); setReport((r) => ({...r, termVersionId: v, productId: String(next?.products?.[0]?.product_id ?? '')})); setPicked(false); setStep('edit'); }} />
            : <div className="on-field"><span className="on-field-label">条件版</span><span className="mg-derived">第{version?.version}版（保証額 {yen(version?.mg_amount_yen)}）</span></div>}
          {version?.products?.length > 1
            ? <FormField type="select" label="対象商品" includeBlank={false} disabled={Boolean(correction)} value={String(report.productId)}
                options={version.products.map((p) => ({value: String(p.product_id), label: `${p.sku}｜${p.name}`}))} onChange={(v) => { patch('productId', v); setPicked(false); }} />
            : <div className="on-field"><span className="on-field-label">対象商品</span><span className="mg-derived">{product ? `${product.sku}｜${product.name}` : '商品がありません'}</span></div>}
          <FormField type="select" label="報告の対象期間（締めの日程から）" value={periodIndex >= 0 ? String(periodIndex) : ''} blankLabel={periods.length ? '日程にない期間（下の日付で指定）' : '日程を読み込み中'}
            options={periods.map((p, i) => ({value: String(i), label: `${dateJst(p.periodFrom)}〜${dateJst(p.periodTo)}（報告予定 ${dateJst(p.reportOn)}）${doneKeys.has(`${p.periodFrom}|${p.periodTo}`) ? '・報告済み' : ''}`}))}
            onChange={(v) => { if (v === '') return; const p = periods[Number(v)]; setPicked(true); setReport((r) => ({...r, periodFrom: p.periodFrom, periodTo: p.periodTo})); setStep('edit'); }}
            hint={periodState.error ? '締めの日程を読み込めませんでした。日付を直接入れてください' : undefined} wide />
          <FormField type="date" label="対象開始日" required value={report.periodFrom} error={errors.periodFrom} onChange={(v) => { setPicked(true); patch('periodFrom', v); }} />
          <FormField type="date" label="対象終了日" required value={report.periodTo} error={errors.periodTo} onChange={(v) => { setPicked(true); patch('periodTo', v); }} />
          <FormField type="month" label="計上月" required value={report.accountingMonth} error={errors.accountingMonth} onChange={(v) => patch('accountingMonth', v)} hint="計上の基準は未確定のため手で指定します（既定は今月）" />
          <FormField type="date" label="実報告受領日" value={report.reportReceivedOn} onChange={(v) => patch('reportReceivedOn', v)} hint="任意。報告予定日とは別です" />
          <FormField label="報告資料の参照" required value={report.sourceReference} error={errors.sourceReference} onChange={(v) => patch('sourceReference', v)} placeholder="例: 2026年Q4 報告書" wide />
          <FormField type="yen" label={L.reportedEligibleYen} required value={report.reportedEligibleYen} allowNegative={false} error={errors.reportedEligibleYen} onChange={(v) => patch('reportedEligibleYen', v)} hint="当期の消化対象（分配金）。累計ではありません" />
          {amountField('appliedRecoupYen', shownApplied, 'applied', candidate?.appliedYen)}
          {amountField('reportedOverageYen', shownOverage, 'overage', candidate?.overageYen)}
          <FormField type="yen" label={L.recognizedYen} required value={report.recognizedYen} allowNegative={false} error={errors.recognizedYen} onChange={(v) => patch('recognizedYen', v)} hint="計上の方針が未確定のため候補は出しません。報告書の計上額を入れてください" />
          {needsReason && <FormField label="候補との差の理由" required value={report.differenceReason} error={errors.differenceReason} onChange={(v) => patch('differenceReason', v)} wide hint={`候補との差: ${differenceText(difference)}`} />}
        </div>
        <div className="mg-candidate" role="region" aria-live="polite" aria-label="候補の計算">
          <strong>候補の計算{special ? '（特殊条件のため参考値）' : ''}</strong>
          <dl>
            <dt>MG保証額（第{version?.version}版）</dt><dd>{yen(version?.mg_amount_yen)}</dd>
            <dt>この報告の前の{L.appliedRecoupYen}{correction ? '（訂正する元の報告を除く）' : ''}</dt><dd>{yen(prior)}</dd>
            <dt>この報告の前の未消化残高</dt><dd>{yen(Math.max(0, Number(version?.mg_amount_yen || 0) - prior))}</dd>
            {candidate ? (
              <>
                <dt>{L.appliedRecoupYen}の候補（{L.reportedEligibleYen}と残高の小さい方）</dt><dd>{yen(candidate.appliedYen)}</dd>
                <dt>{L.reportedOverageYen}の候補（{L.reportedEligibleYen}−{L.appliedRecoupYen}）</dt><dd>{yen(candidate.overageYen)}</dd>
                <dt>登録後の未消化残高</dt><dd>{remainingAfter === null ? '—' : yen(remainingAfter)}</dd>
              </>
            ) : <><dt>候補</dt><dd>{L.reportedEligibleYen}を入れると計算します</dd></>}
          </dl>
          {difference?.differs && <p className={special ? 'mg-muted' : 'mg-diff'}>候補との差: {differenceText(difference)}{special ? '（参考）' : '。理由を入れてください'}</p>}
          {mismatch && <p className="mg-diff">{mismatch}</p>}
          {candidate?.reachesNow && <p className="mg-muted">この報告で保証額に到達します。</p>}
        </div>
      </div>
      <div className="mg-status-row">
        <span className="on-field-label">確認状態</span>
        <div className="on-segmented" role="group" aria-label="確認状態">
          {Object.entries(MG_STATUS_LABELS).map(([value, label]) => <button key={value} type="button" aria-pressed={report.status === value} onClick={() => patch('status', value)}>{label}</button>)}
        </div>
      </div>
      {report.status === 'reviewed' && (
        <label className="mg-check">
          <input type="checkbox" checked={report.acknowledgement} onChange={(e) => patch('acknowledgement', e.target.checked)} />
          報告原本と入力値を照合した
        </label>
      )}
      {errors.acknowledgement && <p className="on-field-error">{errors.acknowledgement}</p>}
      {(report.status === 'reviewed' || correction) && (
        <div className="on-form-grid">
          <FormField label={correction ? '訂正の理由' : '確認の理由'} required value={report.confirmationReason} error={errors.confirmationReason} onChange={(v) => patch('confirmationReason', v)} wide />
        </div>
      )}
      {step === 'edit' ? (
        <div className="on-form-actions">
          <button type="button" onClick={review} disabled={readOnly || !version || !product}>内容を確認する</button>
          {readOnly && <span className="mg-muted">プレビューでは登録できません。</span>}
        </div>
      ) : (
        <ConfirmPanel title={correction ? '登録する訂正版の内容' : '登録する報告の内容'} busy={busy} readOnly={readOnly}
          confirmLabel={correction ? '元の報告を残して訂正版を登録する' : 'この内容で登録する'} onConfirm={save} onBack={() => setStep('edit')}
          note="台帳の行は登録後に変更・削除できません。直すときは訂正版を登録します。"
          items={[
            ['契約・版・商品', `${contract.code}・第${version?.version}版・${product?.sku}｜${product?.name}`], ['対象期間', `${dateJst(payload.periodFrom)}〜${dateJst(payload.periodTo)}`],
            ['計上月', monthText(payload.accountingMonth)], ['報告資料', payload.sourceReference],
            [L.reportedEligibleYen, yen(payload.reportedEligibleYen)], [L.appliedRecoupYen, `${yen(payload.appliedRecoupYen)}${difference?.appliedDiffYen ? `（候補との差 ${signedYen(difference.appliedDiffYen)}）` : ''}`],
            [L.reportedOverageYen, `${yen(payload.reportedOverageYen)}${difference?.overageDiffYen ? `（候補との差 ${signedYen(difference.overageDiffYen)}）` : ''}`], [L.recognizedYen, yen(payload.recognizedYen)],
            ['登録後の未消化残高', remainingAfter === null ? '—' : yen(remainingAfter)], ['確認状態', MG_STATUS_LABELS[payload.status]],
            payload.differenceReason && ['候補との差の理由', payload.differenceReason], payload.confirmationReason && [correction ? '訂正の理由' : '確認の理由', payload.confirmationReason],
          ]} />
      )}
    </section>
  );
}

// ---- 台帳 ----

const amountCell = (key) => (row) => {
  const value = row[key];
  if (row.superseded) return <del className="mg-old" aria-label={`訂正前 ${int(value)}`}>{int(value)}</del>;
  return value === 0 ? <span className="dg-muted" aria-label="0">—</span> : int(value);
};
const runningCell = (key) => (row) => (row.superseded ? <span className="mg-old">集計外</span> : int(row[key]));

const LEDGER_COLUMNS = [
  {key: 'accountingMonth', label: '計上月', type: 'month', sticky: true},
  {key: 'contractLabel', label: '契約', type: 'text'},
  {key: 'versionText', label: '版', type: 'text', value: (row) => (row.termVersion ? `第${row.termVersion}版` : '')},
  {key: 'productLabel', label: '商品', type: 'text'},
  {key: 'periodText', label: '対象期間', type: 'text', value: (row) => `${dateJst(row.periodFrom)}〜${dateJst(row.periodTo)}`},
  ...['eligible', 'applied', 'overage', 'recognized'].map((key, index) => ({
    // 訂正前の行は合計に入れない（値は0、表示と出力は元の金額）
    key, label: Object.values(MG_AMOUNT_LABELS)[index], type: 'yen', total: 'sum', value: (row) => (row.superseded ? 0 : row[key]), exportValue: (row) => row[key], render: amountCell(key),
  })),
  {key: 'cumulativeAppliedYen', label: `累計の${L.appliedRecoupYen}`, type: 'yen', total: 'none', render: runningCell('cumulativeAppliedYen')},
  {key: 'remainingYen', label: '未消化残高（この行まで）', type: 'yen', total: 'none', render: runningCell('remainingYen')},
  {key: 'stateLabel', label: '確認状態', type: 'text', render: (row) => <StateBadge state={row.state} label={row.stateLabel} />},
  {key: 'sourceReference', label: '報告資料参照', type: 'text', wrap: true},
  {key: 'reversesSource', label: '訂正元', type: 'text', value: (row) => row.reversesSource || ''},
  {key: 'reportReceivedOn', label: '実報告受領日', type: 'date', hidden: true},
];

function LedgerDetail({row, readOnly, onCorrect, successor}) {
  return (
    <div className="mg-ledger-detail">
      <dl>
        <dt>契約・版</dt><dd>{row.contractLabel}・第{row.termVersion}版</dd>
        <dt>対象期間</dt><dd>{dateJst(row.periodFrom)}〜{dateJst(row.periodTo)}</dd>
        <dt>実報告受領日</dt><dd>{row.reportReceivedOn ? dateJst(row.reportReceivedOn) : '未入力'}</dd>
        <dt>報告資料参照</dt><dd>{row.sourceReference}</dd>
        {row.confirmationReason && <><dt>確認・訂正理由</dt><dd>{row.confirmationReason}</dd></>}
        {row.reversesSource && <><dt>訂正元</dt><dd>{row.reversesSource}（元の報告は訂正前として残しています）</dd></>}
        {successor && <><dt>訂正版</dt><dd>{successor.sourceReference}（{monthText(successor.accountingMonth)}計上）</dd></>}
      </dl>
      {!row.superseded && !readOnly && <button type="button" className="secondary" onClick={() => onCorrect(row)}>この報告の訂正版を入力</button>}
    </div>
  );
}

// ---- Excel取込 ----

const ACTION_LABELS = {insert: '追加', correction: '訂正版', unchanged: '登録済み', error: 'エラー'};
const PREVIEW_CELLS = [
  ['contract', '契約', ['契約コード']], ['version', '版', ['条件版']], ['product', '商品', ['商品コード']], ['period', '対象期間', ['対象開始日', '対象終了日']],
  ['accountingMonth', '計上月', ['計上月']], ['sourceReference', '報告資料参照', ['報告資料参照', '訂正元の報告資料参照']],
  ['reportedEligibleYen', L.reportedEligibleYen, [L.reportedEligibleYen]], ['appliedRecoupYen', L.appliedRecoupYen, [L.appliedRecoupYen, '候補との差の理由']],
  ['reportedOverageYen', L.reportedOverageYen, [L.reportedOverageYen]], ['recognizedYen', L.recognizedYen, [L.recognizedYen]],
  ['status', '確認状態', ['確認状態', '原本と照合した', '確認・訂正理由']],
];

function previewCell(key, row) {
  const v = row.values;
  if (key === 'contract') return `${row.contractCode}${row.contractTitle ? `｜${row.contractTitle}` : ''}`;
  if (key === 'version') return row.termVersion ? `第${row.termVersion}版${row.versionAuto ? '（自動）' : ''}` : '—';
  if (key === 'product') return row.sku ? `${row.sku}${row.productName ? `｜${row.productName}` : ''}` : '—';
  if (!v) return '—';
  if (key === 'period') return `${dateJst(v.periodFrom)}〜${dateJst(v.periodTo)}`;
  if (key === 'accountingMonth') return monthText(v.accountingMonth);
  if (key === 'sourceReference') return <>{v.sourceReference}{row.original && <small>訂正元: {row.original.sourceReference}</small>}</>;
  if (key === 'status') return MG_STATUS_LABELS[v.status] || MG_STATUS_LABELS.unverified;
  const before = row.original ? row.original[key] : null;
  const diff = key === 'appliedRecoupYen' ? row.difference?.appliedDiffYen : key === 'reportedOverageYen' ? row.difference?.overageDiffYen : null;
  return (
    <>
      {before !== null && before !== undefined && before !== v[key] && <><del className="mg-old">{int(before)}</del><span aria-hidden="true"> → </span></>}
      {int(v[key])}
      {row.filled?.includes(key) && <small>空欄のため自動で入れました</small>}
      {diff ? <small className="mg-diff">候補との差 {signedYen(diff)}</small> : null}
    </>
  );
}

function ImportPanel({direction, contracts, ledger, parties, selectedContract, request, readOnly, onCommitted}) {
  const shell = useShell();
  const inputId = useId();
  const [open, setOpen] = useState(false);
  const [upload, setUpload] = useState(null);
  const [preview, setPreview] = useState(null);
  const [filter, setFilter] = useState('all');
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState('');
  const [notice, setNotice] = useState(null);
  const [result, setResult] = useState(null);
  const [history, setHistory] = useState([]);
  const short = MG_DIRECTION_SHORT[direction];

  const loadHistory = useCallback(() => request(`/mg/ledger/import/history?direction=${direction}`).then((body) => setHistory(body.rows || [])).catch(() => setHistory([])), [request, direction]);
  useEffect(() => { if (open) loadHistory(); }, [open, loadHistory]);
  useEffect(() => { setUpload(null); setPreview(null); setResult(null); setNotice(null); }, [direction]);
  useEffect(() => {
    shell.registerUnsaved?.('mg-import', preview && !result ? 1 : 0, `${short}台帳の取込（確認中）`);
    return () => shell.registerUnsaved?.('mg-import', 0);
  }, [preview, result]); // eslint-disable-line react-hooks/exhaustive-deps

  function template(only) {
    try {
      const sheets = mgTemplateSheets({direction, contracts, ledger, parties, onlyContractId: only ? selectedContract.id : null});
      downloadReportXlsx(`${reportBaseName(`${short}台帳_取込テンプレート${only ? `_${selectedContract.code}` : ''}`, '')}.xlsx`, {sheets});
    } catch (error) {
      setNotice({tone: 'error', error});
    }
  }

  async function readFile(file) {
    if (!file) return;
    setNotice(null); setResult(null); setPreview(null); setConfirmed(false); setFilter('all');
    setBusy('read');
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      const lower = file.name.toLowerCase();
      let parsed;
      if (lower.endsWith('.xlsx')) {
        let sheets;
        try {
          sheets = decodeXlsx(bytes);
        } catch (error) {
          if (/数式/.test(error.message)) throw new Error('数式のセルがあるため読み込めません。Excelで数式を値に変換（コピーして値として貼り付け）してから保存してください');
          throw error;
        }
        parsed = workbookToMgImport(sheets, {fileName: file.name});
      } else if (lower.endsWith('.csv') || lower.endsWith('.txt')) {
        parsed = {...sheetToMgImport(splitCsv(decodeText(bytes).text), {fileName: file.name, sheetName: 'CSV'}), meta: null};
      } else {
        throw new Error('Excel（.xlsx）か CSV（.csv）を選んでください。.xls（古い形式）は Excel で .xlsx に保存し直してください');
      }
      if (parsed.meta?.kind && parsed.meta.kind !== 'mg_ledger') throw new Error('このファイルはMG台帳の取込用ではありません。上の「テンプレートをダウンロード」から始めてください');
      setUpload(parsed);
      const body = await request('/mg/ledger/import/preview', {method: 'POST', body: JSON.stringify({direction, fileName: file.name, headers: parsed.headers, rows: parsed.rows, meta: parsed.meta})});
      setPreview(body);
      if (body.summary.error) setFilter('error');
    } catch (error) {
      setNotice({tone: 'error', error});
    } finally {
      setBusy('');
    }
  }

  async function commit() {
    if (!preview || readOnly) return;
    setBusy('commit');
    setNotice(null);
    try {
      const body = await request('/mg/ledger/import/commit', {method: 'POST', body: JSON.stringify({direction, fileName: upload.fileName, headers: upload.headers, rows: upload.rows, meta: upload.meta, fingerprint: preview.fingerprint, confirmed: true})});
      setResult(body);
      setPreview(null);
      setUpload(null);
      setConfirmed(false);
      loadHistory();
      onCommitted(`取込で${body.summary.insert}件の報告${body.summary.correction ? `と${body.summary.correction}件の訂正版` : ''}を登録しました（${body.fileName}）。`);
    } catch (error) {
      setNotice({tone: 'error', error});
    } finally {
      setBusy('');
    }
  }

  function downloadFailed() {
    const reasons = new Map(preview.rows.filter((r) => r.action === 'error').map((r) => [r.rowNo, r.errors.map((e) => (e.column ? `${e.column}: ${e.message}` : e.message)).join(' ／ ')]));
    const columns = [{key: '__row', label: '行', type: 'int'}, ...upload.headers.map((h, i) => ({key: `c${i}`, label: h || `列${i + 1}`, type: 'text'})), {key: '__reason', label: '取り込めない理由', type: 'text', wrap: true, width: 60}];
    const rows = upload.rows.filter((r) => reasons.has(r.rowNo)).map((r) => ({__row: r.rowNo, ...Object.fromEntries(upload.headers.map((_, i) => [`c${i}`, r.values[i]])), __reason: reasons.get(r.rowNo)}));
    try {
      downloadReportXlsx(`${reportBaseName(`${short}台帳_取込できない行`, '')}.xlsx`, {sheets: [{name: '取込できない行', title: `${short}台帳の取込 取り込めない行`, conditions: [['ファイル', upload.fileName]], columns, rows, freezeCols: 1}]});
    } catch (error) {
      setNotice({tone: 'error', error});
    }
  }

  const s = preview?.summary;
  const shown = preview ? preview.rows.filter((row) => filter === 'all' || row.action === filter) : [];
  return (
    <section className="card mg-import" aria-labelledby={`${inputId}-title`}>
      <header className="mg-section-head">
        <div>
          <h3 id={`${inputId}-title`}>{short}台帳をExcelで取り込む</h3>
          <p className="mg-muted">複数の報告をまとめて登録します。読み込むと、登録前に候補との差・訂正版・エラーを表で確かめられます。1行でもエラーがあれば登録しません。</p>
        </div>
        <button type="button" className={open ? 'secondary' : ''} aria-expanded={open} onClick={() => setOpen((v) => !v)}>{open ? '閉じる' : 'Excelで取り込む'}</button>
      </header>
      {open && (
        <div className="mg-import-body">
          <NoticeView notice={notice} onDismiss={() => setNotice(null)} />
          <ol className="mg-steps">
            <li>
              <strong>1. テンプレートを用意する</strong>
              <div className="on-form-actions">
                <button type="button" className="secondary" onClick={() => template(false)} disabled={!contracts.length}>テンプレートをダウンロード（{short}の全契約）</button>
                {selectedContract && <button type="button" className="secondary" onClick={() => template(true)}>{selectedContract.code}だけのテンプレート</button>}
              </div>
              <p className="mg-muted">契約コードと商品コードを入れた行があります。報告のある行に対象期間・計上月・報告資料参照・{L.reportedEligibleYen}・{L.recognizedYen}を記入します。{L.appliedRecoupYen}・{L.reportedOverageYen}は空欄なら候補が入ります。</p>
            </li>
            <li>
              <strong>2. ファイルを読み込む</strong>
              <label className={`mg-drop${busy === 'read' ? ' is-busy' : ''}`} onDragOver={(e) => e.preventDefault()} onDrop={(e) => { e.preventDefault(); if (!readOnly) readFile(e.dataTransfer.files?.[0]); }}>
                <input type="file" accept=".xlsx,.csv" disabled={readOnly || busy === 'read'} onChange={(e) => { readFile(e.target.files?.[0]); e.target.value = ''; }} />
                <span>{busy === 'read' ? '読み込み中…' : 'Excel（.xlsx）か CSV をここへドラッグ、または押して選ぶ'}</span>
              </label>
              {preview?.limits && <p className="mg-muted">1回に{int(preview.limits.bulkRows)}行まで（{preview.limits.reason}）。</p>}
            </li>
          </ol>
          {preview && (
            <div className="mg-preview">
              <p className="mg-file"><strong>{upload?.fileName}</strong>（{upload?.sheetName}シート・見出しは{upload?.headerRowNo}行目）</p>
              <div className="mg-counts" role="group" aria-label="判定の件数">
                {['insert', 'correction', 'unchanged', 'error'].map((key) => (
                  <button key={key} type="button" className={`mg-count is-${key}`} aria-pressed={filter === key} onClick={() => setFilter(filter === key ? 'all' : key)}>
                    <span>{ACTION_LABELS[key]}</span><strong>{int(s[key])}</strong>
                  </button>
                ))}
                <div className="mg-count is-skipped"><span>記入前の行</span><strong>{int(s.skipped)}</strong><small>読み飛ばし</small></div>
              </div>
              {(preview.ignoredColumns.length > 0 || preview.unknownColumns.length > 0 || preview.duplicateColumns.length > 0) && (
                <Notice tone="info" compact message={[
                  preview.ignoredColumns.length ? `参考の列（読み込まない）: ${preview.ignoredColumns.join('、')}` : '',
                  preview.unknownColumns.length ? `見出しが一致しない列（読み込まない）: ${preview.unknownColumns.join('、')}` : '',
                  preview.duplicateColumns.length ? `同じ見出しの2つ目以降（読み込まない）: ${preview.duplicateColumns.join('、')}` : '',
                ].filter(Boolean).join(' ／ ')} />
              )}
              <div className="mg-table-wrap">
                <table className="mg-table">
                  <thead>
                    <tr><th scope="col">行</th><th scope="col">判定</th>{PREVIEW_CELLS.map(([key, label]) => <th key={key} scope="col" className={['reportedEligibleYen', 'appliedRecoupYen', 'reportedOverageYen', 'recognizedYen'].includes(key) ? 'num' : undefined}>{label}</th>)}</tr>
                  </thead>
                  <tbody>
                    {shown.map((row) => {
                      const errorColumns = new Set(row.errors.map((e) => e.column));
                      const notes = [...row.errors.map((e) => ({tone: 'bad', text: e.column ? `${e.column}: ${e.message}` : e.message})), ...row.warnings.map((text) => ({tone: 'warn', text}))];
                      return (
                        <React.Fragment key={row.rowNo}>
                          <tr className={`is-${row.action}`}>
                            <th scope="row" className="num">{row.rowNo}</th>
                            <td><span className={`mg-badge is-${row.action}`}>{ACTION_LABELS[row.action]}</span></td>
                            {PREVIEW_CELLS.map(([key, , headers]) => {
                              const bad = headers.some((h) => errorColumns.has(h));
                              return <td key={key} className={`${bad ? 'mg-cell-error' : ''}${['reportedEligibleYen', 'appliedRecoupYen', 'reportedOverageYen', 'recognizedYen'].includes(key) ? ' num' : ''}`} aria-invalid={bad ? 'true' : undefined}>{previewCell(key, row)}</td>;
                            })}
                          </tr>
                          {notes.length > 0 && (
                            <tr className="mg-row-note"><td colSpan={PREVIEW_CELLS.length + 2}>{notes.map((n, i) => <span key={i} className={n.tone === 'bad' ? 'mg-reason' : 'mg-note'}>{n.text}</span>)}</td></tr>
                          )}
                        </React.Fragment>
                      );
                    })}
                  </tbody>
                </table>
                {!shown.length && <p className="mg-muted">この条件の行はありません。</p>}
              </div>
              {s.error > 0 ? (
                <div className="on-form-actions">
                  <Notice tone="error" message={`エラーが${s.error}行あるため登録できません。1行でもエラーがあればファイル全体を登録しません。`} />
                  <button type="button" className="secondary" onClick={downloadFailed}>取り込めない行をExcelで出力（理由つき）</button>
                </div>
              ) : preview.canCommit ? (
                <div className="mg-commit">
                  <label className="mg-check">
                    <input type="checkbox" checked={confirmed} onChange={(e) => setConfirmed(e.target.checked)} />
                    内容を確認しました（追加 {s.insert}件・訂正版 {s.correction}件を登録します。台帳の行は登録後に変更・削除できません）
                  </label>
                  <div className="on-form-actions">
                    <button type="button" disabled={!confirmed || busy === 'commit' || readOnly} onClick={commit}>{busy === 'commit' ? '登録中…' : `${s.insert + s.correction}件を登録する`}</button>
                    <button type="button" className="text" onClick={() => { setPreview(null); setUpload(null); }}>読み込みをやめる</button>
                  </div>
                </div>
              ) : (
                <Notice tone="info" message="登録する新しい報告はありません（すべて登録済みの内容です）。" />
              )}
            </div>
          )}
          {result && <Notice tone="ok" title={`${result.inserted.length}件を登録しました`} message={`データベースから読み直した報告資料参照: ${result.saved.map((r) => r.source_reference).join('、')}`} onDismiss={() => setResult(null)} />}
          {history.length > 0 && (
            <details className="mg-history">
              <summary>{short}台帳の取込の記録（最近{history.length}件）</summary>
              <table className="mg-table">
                <thead><tr><th scope="col">日時</th><th scope="col">ファイル</th><th scope="col" className="num">追加</th><th scope="col" className="num">訂正版</th><th scope="col">登録者</th></tr></thead>
                <tbody>{history.map((h) => <tr key={h.batch}><td>{dateTimeJst(h.at)}</td><td>{h.fileName}</td><td className="num">{int(h.insert)}</td><td className="num">{int(h.correction)}</td><td>{h.userName}</td></tr>)}</tbody>
              </table>
            </details>
          )}
        </div>
      )}
    </section>
  );
}

// ---- 仕入先・関連 ----

function SupplierPanel({suppliers, request, readOnly, onSaved}) {
  const [supplier, setSupplier] = useState({code: 'SUP-', name: '', note: ''});
  const [errors, setErrors] = useState({});
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState(null);
  async function save() {
    const next = {};
    if (!/^SUP-.+/.test(supplier.code.trim())) next.code = '仕入先コードは SUP- で始めてください（例: SUP-001）';
    if (!supplier.name.trim()) next.name = '仕入先名を入力してください';
    setErrors(next);
    if (Object.keys(next).length || busy || readOnly) return;
    setBusy(true);
    try {
      await request('/mg/suppliers', {method: 'POST', body: JSON.stringify({...supplier, code: supplier.code.trim(), name: supplier.name.trim()})});
      setSupplier({code: 'SUP-', name: '', note: ''});
      setNotice(null);
      onSaved(`仕入先「${supplier.name.trim()}」を登録しました。`);
    } catch (error) {
      setNotice(errorNotice(error, {unique: '同じ仕入先コードが登録済みです'}));
    } finally {
      setBusy(false);
    }
  }
  return (
    <details className="card mg-details">
      <summary>仕入先・権利元（{suppliers.length}件）</summary>
      <p className="mg-muted">取引先とは別の仕入先コードで管理します。</p>
      {suppliers.length > 0 && <ul className="mg-list">{suppliers.map((s) => <li key={s.id}>{s.code}｜{s.name}{s.note ? `（${s.note}）` : ''}</li>)}</ul>}
      <NoticeView notice={notice} onDismiss={() => setNotice(null)} />
      <div className="on-form-grid">
        <FormField label="仕入先コード" required value={supplier.code} error={errors.code} onChange={(v) => setSupplier((s) => ({...s, code: v}))} />
        <FormField label="仕入先名" required value={supplier.name} error={errors.name} onChange={(v) => setSupplier((s) => ({...s, name: v}))} />
        <FormField label="メモ" value={supplier.note} onChange={(v) => setSupplier((s) => ({...s, note: v}))} />
      </div>
      <div className="on-form-actions"><button type="button" disabled={busy || readOnly} onClick={save}>{busy ? '登録中…' : '仕入先を登録する'}</button></div>
    </details>
  );
}

function LinksPanel({links, both, request, readOnly, onSaved}) {
  const [link, setLink] = useState({incomingContractId: '', outgoingContractId: '', rationale: ''});
  const [errors, setErrors] = useState({});
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState(null);
  const label = (list, id) => {
    const c = list.find((x) => Number(x.id) === Number(id));
    return c ? `${c.code}｜${c.title}` : '参照できない契約';
  };
  async function save() {
    const next = {};
    if (!link.incomingContractId) next.incomingContractId = '受取MGの契約を選んでください';
    if (!link.outgoingContractId) next.outgoingContractId = '支払MGの契約を選んでください';
    if (!link.rationale.trim()) next.rationale = '関連付けの理由を入力してください';
    setErrors(next);
    if (Object.keys(next).length || busy || readOnly) return;
    setBusy(true);
    try {
      await request('/mg/links', {method: 'POST', body: JSON.stringify(link)});
      setLink({incomingContractId: '', outgoingContractId: '', rationale: ''});
      setNotice(null);
      onSaved('契約の関連を登録しました。');
    } catch (error) {
      setNotice(errorNotice(error, {unique: 'この組み合わせの関連は登録済みです'}));
    } finally {
      setBusy(false);
    }
  }
  return (
    <details className="card mg-details">
      <summary>受取MGと支払MGの関連（{links.length}件）</summary>
      <p className="mg-muted">関連を付けても、評価額・分配条件・回収条件は転用しません（監査用の印です）。</p>
      {links.length > 0 && <ul className="mg-list">{links.map((k) => <li key={k.id}>{label(both.incoming, k.incoming_contract_id)} → {label(both.outgoing, k.outgoing_contract_id)}：{k.rationale}</li>)}</ul>}
      <NoticeView notice={notice} onDismiss={() => setNotice(null)} />
      <div className="on-form-grid">
        <FormField type="select" label="受取MGの契約" required value={link.incomingContractId} error={errors.incomingContractId} options={both.incoming.map((c) => ({value: String(c.id), label: `${c.code}｜${c.title}`}))} onChange={(v) => setLink((l) => ({...l, incomingContractId: v}))} />
        <FormField type="select" label="支払MGの契約" required value={link.outgoingContractId} error={errors.outgoingContractId} options={both.outgoing.map((c) => ({value: String(c.id), label: `${c.code}｜${c.title}`}))} onChange={(v) => setLink((l) => ({...l, outgoingContractId: v}))} />
        <FormField label="関連付けの理由" required value={link.rationale} error={errors.rationale} onChange={(v) => setLink((l) => ({...l, rationale: v}))} wide />
      </div>
      <div className="on-form-actions"><button type="button" disabled={busy || readOnly} onClick={save}>{busy ? '登録中…' : '関連を登録する'}</button></div>
    </details>
  );
}

// ---- 画面 ----

export default function MgLedger({request: requestProp}) {
  const shell = useShell();
  const request = requestProp || shell.request;
  const readOnly = Boolean(shell.readOnly);
  const [direction, setDirection] = useViewParam(shell, 'dir', 'incoming');
  const [selectedParam, setSelected] = useViewParam(shell, 'contract', '');
  const [ledgerContract, setLedgerContract] = useViewParam(shell, 'ledgerContract', '');
  const [ledgerProduct, setLedgerProduct] = useViewParam(shell, 'ledgerProduct', '');
  const [ledgerMonth, setLedgerMonth] = useViewParam(shell, 'ledgerMonth', '');
  const [showHistory, setShowHistory] = useState(false);
  const [data, setData] = useState({catalog: {partners: [], products: [], suppliers: []}, both: {incoming: [], outgoing: []}, ledger: [], links: [], loadedAt: null});
  const [state, setState] = useState({loading: true, error: null});
  const [notice, setNotice] = useState(null);
  const [contractForm, setContractForm] = useState(null);
  const [correction, setCorrection] = useState(null);
  const [reportNonce, setReportNonce] = useState(0);
  const detailRef = useRef(null);

  const load = useCallback(async () => {
    setState((s) => ({...s, loading: true, error: null}));
    try {
      const [catalog, incoming, outgoing, ledger, links] = await Promise.all([request('/mg/catalog'), request('/mg/contracts?direction=incoming'), request('/mg/contracts?direction=outgoing'), request('/mg/ledger'), request('/mg/links')]);
      setData({catalog, both: {incoming: incoming.contracts || [], outgoing: outgoing.contracts || []}, ledger: ledger.rows || [], links: links.links || [], loadedAt: new Date().toISOString()});
      setState({loading: false, error: null});
    } catch (error) {
      setState({loading: false, error});
    }
  }, [request]);
  useEffect(() => { load(); }, [load]);

  const contracts = data.both[direction] || [];
  const parties = direction === 'incoming' ? data.catalog.partners || [] : data.catalog.suppliers || [];
  const partyOf = (contract) => parties.find((p) => Number(p.id) === Number(contract.party_id));
  const progress = useMemo(() => new Map(contracts.map((c) => [Number(c.id), contractProgress(c, data.ledger, direction)])), [contracts, data.ledger, direction]);
  const totals = progressTotals([...progress.values()]);
  const selected = contracts.find((c) => String(c.id) === String(selectedParam)) || null;
  const selectedProgress = selected ? progress.get(Number(selected.id)) : null;
  const productOptions = useMemo(() => {
    const seen = new Map();
    for (const c of contracts) for (const v of c.versions) for (const p of v.products || []) if (!seen.has(p.product_id)) seen.set(p.product_id, {value: String(p.product_id), label: `${p.sku}｜${p.name}`});
    return [...seen.values()];
  }, [contracts]);
  const rows = useMemo(() => ledgerView({ledger: data.ledger, contracts, direction, showHistory, contractId: ledgerContract || null, productId: ledgerProduct || null, month: ledgerMonth}),
    [data.ledger, contracts, direction, showHistory, ledgerContract, ledgerProduct, ledgerMonth]);
  const successors = useMemo(() => new Map(data.ledger.filter((r) => r.reverses_entry_id).map((r) => [Number(r.reverses_entry_id), {sourceReference: r.source_reference, accountingMonth: r.accounting_month}])), [data.ledger]);

  useEffect(() => { if (correction) detailRef.current?.scrollIntoView?.({behavior: 'smooth', block: 'start'}); }, [correction]);

  function changeDirection(next) {
    if (next === direction) return;
    setDirection(next);
    setSelected('');
    setLedgerContract('');
    setLedgerProduct('');
    setContractForm(null);
    setCorrection(null);
  }
  function selectContract(contract) {
    const same = String(contract.id) === String(selectedParam);
    setSelected(same ? '' : String(contract.id));
    setLedgerContract(same ? '' : String(contract.id));
    setCorrection(null);
    if (contractForm?.editing) setContractForm(null);
  }
  function saved(message) {
    setNotice({tone: 'ok', message});
    setContractForm(null);
    setCorrection(null);
    setReportNonce((n) => n + 1);
    load();
  }
  function startCorrection(row) {
    setSelected(String(row.contractId));
    setCorrection(row);
    setContractForm(null);
  }
  function openCreate() {
    setContractForm({key: Date.now(), editing: null, initial: emptyContractForm(todayJst())});
  }
  function openRevise() {
    const version = latestVersion(selected);
    setContractForm({key: Date.now(), editing: {id: selected.id, baseVersion: version.version}, initial: contractFormFromVersion(selected, version)});
  }

  const directionShort = MG_DIRECTION_SHORT[direction];
  const conditions = [['向き', MG_DIRECTION_LABELS[direction]],
    ['契約', ledgerContract ? (contracts.find((c) => String(c.id) === String(ledgerContract))?.code || '指定あり') : 'すべて'],
    ['商品', ledgerProduct ? (productOptions.find((p) => p.value === String(ledgerProduct))?.label || '指定あり') : 'すべて'],
    ['計上月', ledgerMonth ? monthText(ledgerMonth) : 'すべて'], ['訂正前の報告', showHistory ? '表示（合計に含めない）' : '表示しない']];

  return (
    <div className="stack mg-ledger">
      <section className="card mg-hero">
        <h2>MG契約・台帳</h2>
        <p className="mg-muted">販売先から受け取るMG（受取MG）と、権利元へ支払うMG（支払MG）を別々に管理します。金額の呼び名は {Object.values(L).join('・')} に統一しています。</p>
        <Tabs tabs={DIRECTION_TABS.map((t) => ({...t, badge: (data.both[t.id] || []).length || null}))} value={direction} onChange={changeDirection} label="MGの向き" />
      </section>
      <NoticeView notice={notice} onDismiss={() => setNotice(null)} />
      {state.error && <Notice error={state.error} onRetry={state.error?.kind === 'forbidden' ? undefined : load} />}
      {state.loading && !data.loadedAt && <p className="mg-muted" aria-busy="true">読み込み中…</p>}

      {data.loadedAt && (
        <>
          <section className="card mg-contracts" aria-label={`${directionShort}の契約`}>
            <header className="mg-section-head">
              <div>
                <h3>{directionShort}の契約（{contracts.length}件）</h3>
                <p className="mg-muted">累計の{L.appliedRecoupYen}は訂正前を除く全報告の合計、保証額は最新の条件版です。契約を押すと当期の報告と台帳をその契約に絞ります。</p>
              </div>
              <button type="button" onClick={openCreate} disabled={readOnly}>新しい契約を登録する</button>
            </header>
            {contractForm && !contractForm.editing && (
              <ContractForm key={contractForm.key} direction={direction} parties={parties} products={data.catalog.products || []} initial={contractForm.initial} editing={null}
                request={request} readOnly={readOnly} onSaved={saved} onCancel={() => setContractForm(null)} />
            )}
            {contracts.length > 0 && (
              <p className="mg-totals" role="status">
                <span>{contracts.length}契約</span>
                <span>MG保証額の合計 <strong>{yen(totals.guaranteeYen)}</strong></span>
                <span>累計の{L.appliedRecoupYen} <strong>{yen(totals.cumulativeAppliedYen)}</strong></span>
                <span>未消化残高 <strong>{yen(totals.remainingYen)}</strong></span>
                <span>到達率 <strong>{totals.rate === null ? '—' : rate(totals.rate)}</strong></span>
                {totals.unverifiedCount > 0 && <span className="mg-diff">未確認の報告 {int(totals.unverifiedCount)}件</span>}
              </p>
            )}
            {!contracts.length && <Notice tone="info" message={`${directionShort}の契約はまだありません。「新しい契約を登録する」から登録します。`} />}
            <ul className="mg-contract-list">
              {contracts.map((c) => {
                const p = progress.get(Number(c.id));
                const v = latestVersion(c);
                const isSelected = String(c.id) === String(selectedParam);
                return (
                  <li key={c.id}>
                    <button type="button" className={`mg-contract${isSelected ? ' is-selected' : ''}`} aria-pressed={isSelected} onClick={() => selectContract(c)}>
                      <span className="mg-contract-name">
                        <strong>{c.code}｜{c.title}</strong>
                        <small>{partyOf(c)?.name || '相手先未確認'}・第{v?.version}版・{MG_MODE_LABELS[v?.mode] || ''}{p.lastAccountingMonth ? `・最終計上 ${monthText(p.lastAccountingMonth)}` : ''}</small>
                      </span>
                      <span className="mg-nums">
                        <span>保証額 <b>{yen(p.guaranteeYen)}</b></span>
                        <span>累計の{L.appliedRecoupYen} <b>{yen(p.cumulativeAppliedYen)}</b></span>
                        <span>未消化残高 <b>{yen(p.remainingYen)}</b></span>
                        {p.unverifiedCount > 0 && <span className="mg-diff">未確認 {p.unverifiedCount}件</span>}
                      </span>
                      <ProgressBar progress={p} />
                    </button>
                  </li>
                );
              })}
            </ul>
          </section>

          {selected && selectedProgress && (
            <section className="card mg-detail" ref={detailRef} aria-label={`${selected.code}の詳細`}>
              <header className="mg-section-head">
                <div>
                  <p className="mg-eyebrow">{MG_DIRECTION_LABELS[direction]}</p>
                  <h3>{selected.code}｜{selected.title}</h3>
                  <p className="mg-muted">{partyOf(selected)?.name || '相手先未確認'}・契約締結日 {dateJst(selected.contract_date)}（計上月の基準には使いません）・契約資料 {selected.source_reference}</p>
                </div>
                <div className="on-form-actions">
                  <button type="button" className="secondary" onClick={openRevise} disabled={readOnly}>条件を改訂する（新しい版を作る）</button>
                  <button type="button" className="text" onClick={() => { setSelected(''); setCorrection(null); }}>閉じる</button>
                </div>
              </header>
              <div className="mg-tiles">
                <div><span>MG保証額（第{selectedProgress.termVersion}版）</span><strong>{yen(selectedProgress.guaranteeYen)}</strong></div>
                <div><span>累計の{L.appliedRecoupYen}</span><strong>{yen(selectedProgress.cumulativeAppliedYen)}</strong></div>
                <div><span>未消化残高</span><strong>{yen(selectedProgress.remainingYen)}</strong></div>
                <div><span>到達率</span><strong>{selectedProgress.rate === null ? '—' : rate(selectedProgress.rate)}</strong><ProgressBar progress={selectedProgress} compact /></div>
                <div><span>累計の{L.reportedOverageYen}</span><strong>{yen(selectedProgress.cumulativeOverageYen)}</strong></div>
                <div><span>累計の{L.recognizedYen}</span><strong>{yen(selectedProgress.cumulativeRecognizedYen)}</strong></div>
              </div>
              {selectedProgress.special && <Notice tone="warn" compact message="特殊条件の契約です。未消化残高と候補は参考値です。報告原本と照合してください。" />}
              <details className="mg-sub">
                <summary>条件の版（{selected.versions.length}件）</summary>
                <DataGrid rowKey="id" rows={selected.versions.map((v) => ({...v, label: `第${v.version}版`, period: `${dateJst(v.starts_on)}〜${dateJst(v.ends_on)}`, modeLabel: MG_MODE_LABELS[v.mode], evaluations: (v.products || []).map((p) => `${p.sku} ${yen(p.evaluation_yen)}`).join('、')}))}
                  showTotals={false} maxHeight="320px" columns={[
                    {key: 'label', label: '版', type: 'text', sticky: true}, {key: 'period', label: '期間', type: 'text'}, {key: 'modeLabel', label: '回収方式', type: 'text'},
                    {key: 'mg_amount_yen', label: 'MG保証額', type: 'yen'}, {key: 'evaluations', label: '商品と評価額', type: 'text', wrap: true},
                    {key: 'reason', label: '登録・改訂の理由', type: 'text', wrap: true}, {key: 'source_reference', label: '条件の根拠資料', type: 'text', wrap: true},
                    {key: 'created_at', label: '登録日時', type: 'datetime'},
                  ]} />
              </details>
              {contractForm?.editing && (
                <ContractForm key={contractForm.key} direction={direction} parties={parties} products={data.catalog.products || []} initial={contractForm.initial} editing={contractForm.editing}
                  request={request} readOnly={readOnly} onSaved={saved} onCancel={() => setContractForm(null)} />
              )}
              <ReportEntry key={`${selected.id}:${correction?.id || ''}:${reportNonce}`} contract={selected} direction={direction} ledger={data.ledger} request={request}
                readOnly={readOnly} correction={correction && Number(correction.contractId) === Number(selected.id) ? correction : null}
                onCancelCorrection={() => setCorrection(null)} onSaved={saved} />
            </section>
          )}

          <section className="card mg-ledger-card" aria-label={`${directionShort}の台帳`}>
            <header className="mg-section-head">
              <div>
                <h3>{directionShort}の台帳</h3>
                <p className="mg-muted">契約ごとに計上月の順で累計の{L.appliedRecoupYen}と未消化残高を積み上げます（訂正前の報告は除く）。行を押すと詳細と「訂正版を入力」が開きます。</p>
              </div>
            </header>
            <div className="on-conditions mg-filters">
              <FormField type="select" label="契約" value={String(ledgerContract)} blankLabel="すべての契約" options={contracts.map((c) => ({value: String(c.id), label: `${c.code}｜${c.title}`}))} onChange={(v) => setLedgerContract(v)} />
              <FormField type="select" label="商品" value={String(ledgerProduct)} blankLabel="すべての商品" options={productOptions} onChange={(v) => setLedgerProduct(v)} />
              <FormField type="month" label="計上月" value={ledgerMonth} onChange={(v) => setLedgerMonth(v || '')} />
              <div className="mg-filter-actions">
                {(ledgerContract || ledgerProduct || ledgerMonth) && <button type="button" className="secondary" onClick={() => { setLedgerContract(''); setLedgerProduct(''); setLedgerMonth(''); }}>絞込を解除</button>}
                <label className="mg-check"><input type="checkbox" checked={showHistory} onChange={(e) => setShowHistory(e.target.checked)} />訂正前の報告も表示する（合計には含めない）</label>
              </div>
            </div>
            <DataGrid columns={LEDGER_COLUMNS} rows={rows} rowKey="key" persistKey={`mg-ledger-${direction}`} emptyText={data.ledger.some((r) => (direction === 'incoming' ? r.incoming_contract_id : r.outgoing_contract_id)) ? '条件に合う報告はありません' : `${directionShort}の報告はまだありません`}
              renderDetail={(row) => <LedgerDetail row={row} readOnly={readOnly} successor={successors.get(row.id)} onCorrect={startCorrection} />}
              exportSpec={{name: `${directionShort}台帳`, title: `${directionShort}台帳`, period: ledgerMonth || '', conditions, dataAsOf: data.loadedAt,
                notes: [`累計の${L.appliedRecoupYen}・未消化残高は、契約ごとに計上月の順で訂正前を除いて積み上げた値。残高はその行の条件版の保証額から計算。`, '訂正前の報告の金額は合計に含めません。受取MGと支払MGは合算しません。']}} />
          </section>

          <ImportPanel direction={direction} contracts={contracts} ledger={data.ledger} parties={parties} selectedContract={selected} request={request} readOnly={readOnly} onCommitted={saved} />
          {direction === 'outgoing' && <SupplierPanel suppliers={data.catalog.suppliers || []} request={request} readOnly={readOnly} onSaved={saved} />}
          <LinksPanel links={data.links} both={data.both} request={request} readOnly={readOnly} onSaved={saved} />
        </>
      )}
    </div>
  );
}
