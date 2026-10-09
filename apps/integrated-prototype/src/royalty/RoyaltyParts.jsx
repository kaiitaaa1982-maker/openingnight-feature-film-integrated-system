// ロイヤリティの画面で共通に使う部品（条件版の入力欄、サイクルのフェーズの編集、状態の表示、理由つきの取消）。
import React, {useState} from 'react';
import {FormField} from '../ui/FormField.jsx';
import {Notice} from '../ui/Notice.jsx';
import {describeError} from '../ui/api-client.mjs';
import {labelOf} from '../ui/labels.mjs';
import {WINDOW_FEE_BASES, EXPENSE_BASES, cycleText} from './royalty-model.mjs';
import {
  CALC_METHOD_OPTIONS, BASE_KIND_OPTIONS, CHANNEL_OPTIONS, CYCLE_OPTIONS, DUE_OPTIONS, DAY_OPTIONS, OFFSET_OPTIONS, statusTone, emptyPhase, allowsFirstClose,
} from './royalty-ui.mjs';
import './royalty.css';

export function StatusBadge({status, label}) {
  return <span className={`ry-status is-${statusTone(status)}`}>{label || labelOf('royaltyPeriodStatus', status)}</span>;
}

// サーバーの検査結果をまとめて出す（項目の英字名は出さず、日本語の理由だけ）
export function ErrorNotice({error}) {
  if (!error) return null;
  const list = Array.isArray(error?.details?.errors) ? error.details.errors.map((item) => item.message) : [];
  return <Notice tone="error" message={list.length ? '入力内容を確認してください' : describeError(error)} details={list.length ? list : undefined} />;
}

function CheckGroup({legend, options, value = [], onChange, disabled, hint}) {
  const toggle = (option) => onChange(value.includes(option) ? value.filter((item) => item !== option) : [...value, option]);
  return (
    <fieldset className="ry-checks on-field-wide" disabled={disabled}>
      <legend>{legend}</legend>
      {options.map((option) => (
        <label key={option.value} className="check">
          <input type="checkbox" checked={value.includes(option.value)} onChange={() => toggle(option.value)} />
          <span>{option.label}</span>
        </label>
      ))}
      {hint && <p className="on-field-hint" style={{flexBasis: '100%', margin: 0}}>{hint}</p>}
    </fieldset>
  );
}

// 条件版の入力欄。value は royalty-ui.mjs の emptyTerm() の形（文字のまま）。errors は項目名 → 日本語
export function TermFields({value, onChange, errors = {}, expenseCategories = [], showEffectiveFrom = true, showReason = false, disabled = false}) {
  const set = (key) => (next) => onChange({...value, [key]: next});
  const [extraCategory, setExtraCategory] = useState('');
  const categories = [...new Set([...expenseCategories, ...value.expenseCategories])];
  return (
    <div className="on-form-grid">
      {showEffectiveFrom && <FormField type="month" label="適用開始の計上月" required value={value.effectiveFrom} onChange={set('effectiveFrom')} error={errors.effectiveFrom}
        hint="この計上月の売上から、この条件で計算します" disabled={disabled} />}
      <FormField type="select" label="計算方法" required value={value.calcMethod} includeBlank={false} options={CALC_METHOD_OPTIONS} onChange={set('calcMethod')} error={errors.calcMethod} disabled={disabled} />
      {value.calcMethod === 'rate' && (
        <>
          <FormField type="select" label="料率をかける基礎" required value={value.baseKind} includeBlank={false} options={BASE_KIND_OPTIONS} onChange={set('baseKind')} error={errors.baseKind}
            hint={value.baseKind.startsWith('committee') ? '本委員会収入は、製作委員会の条件（窓口・手数料）から計算した額です' : null} disabled={disabled} />
          <FormField type="text" label="料率（%）" required value={value.ratePercent} onChange={set('ratePercent')} error={errors.rateBps} placeholder="例: 3.5" disabled={disabled} />
          {WINDOW_FEE_BASES.includes(value.baseKind) && (
            <FormField type="text" label="窓口手数料率（%）" required value={value.windowFeePercent} onChange={set('windowFeePercent')} error={errors.windowFeeBps} placeholder="例: 25"
              hint="売上からこの率の手数料を引いた額を基礎にします" disabled={disabled} />
          )}
          <CheckGroup legend="対象の流通（選ばなければすべての流通）" options={CHANNEL_OPTIONS} value={value.channels} onChange={set('channels')} disabled={disabled}
            hint="ビデオグラムの区分（レンタル／セル）が未確認の売上は、レンタルとセルの両方を選んだときだけ入ります。片方だけのときは保留にします" />
          {EXPENSE_BASES.includes(value.baseKind) && (
            <div className="on-field-wide stack" style={{gap: 8}}>
              <CheckGroup legend="差し引く経費の費目（選ばなければその月の経費すべて）" options={categories.map((c) => ({value: c, label: c}))} value={value.expenseCategories}
                onChange={set('expenseCategories')} disabled={disabled} />
              <div className="ry-actions">
                <FormField type="text" label="ほかの費目を足す" value={extraCategory} onChange={setExtraCategory} disabled={disabled} />
                <button type="button" className="secondary" disabled={disabled || !extraCategory.trim()}
                  onClick={() => { onChange({...value, expenseCategories: [...new Set([...value.expenseCategories, extraCategory.trim()])]}); setExtraCategory(''); }}>費目を足す</button>
              </div>
            </div>
          )}
        </>
      )}
      {value.calcMethod === 'fixed_monthly' && (
        <FormField type="yen" label="毎月の定額" required value={value.fixedAmount} onChange={set('fixedAmount')} error={errors.fixedAmountYen} disabled={disabled} />
      )}
      {value.calcMethod === 'manual' && (
        <p className="on-field-hint on-field-wide">音楽著作権料の分配明細など、実際の額を「実額の計上」で月ごとに入れます。</p>
      )}
      <FormField type="yen" label="前払金（なしは0）" value={value.advance} onChange={set('advance')} error={errors.advanceYen}
        hint="報告済みの累計発生額が前払金に達するまで、支払から差し引きます" disabled={disabled} />
      <FormField type="yen" label="支払の下限（なしは空欄）" value={value.minPayment} onChange={set('minPayment')} error={errors.minPaymentYen}
        hint="この額未満の期は支払わず、翌期へ繰り越します" disabled={disabled} />
      <FormField type="text" label="根拠の条項" required value={value.clauseReference} onChange={set('clauseReference')} error={errors.clauseReference} placeholder="例: 第8条第2項" disabled={disabled} />
      {showReason && <FormField type="textarea" label="条件を変える理由" required value={value.reason} onChange={set('reason')} error={errors.reason} rows={2} disabled={disabled} />}
    </div>
  );
}

function DueInput({label, value, onChange, disabled}) {
  const set = (key) => (next) => onChange({...value, [key]: next});
  return (
    <div className="ry-due">
      <FormField type="select" label={label} value={value.preset} includeBlank={false} options={DUE_OPTIONS} onChange={set('preset')} disabled={disabled} />
      {value.preset === 'custom' && <FormField type="select" label="何か月後" value={value.offset} includeBlank={false} options={OFFSET_OPTIONS} onChange={set('offset')} disabled={disabled} />}
      {value.preset === 'custom' && <FormField type="select" label="日" value={value.day} includeBlank={false} options={DAY_OPTIONS} onChange={set('day')} disabled={disabled} />}
    </div>
  );
}

// サイクルのフェーズ（計上月の期間ごとのサイクル）。途中でサイクルが変わる契約はフェーズを分ける
export function PhaseEditor({phases, onChange, errors = {}, disabled = false}) {
  const update = (index, next) => onChange(phases.map((phase, i) => (i === index ? next : phase)));
  const remove = (index) => onChange(phases.filter((_, i) => i !== index));
  const extraPresets = phases.filter((phase) => !CYCLE_OPTIONS.some((option) => option.value === phase.preset)).map((phase) => {
    const [cycleKind, anchor] = String(phase.preset).split(':');
    return {value: phase.preset, label: cycleText({cycleKind, anchorMonth: anchor ? Number(anchor) : null})};
  });
  return (
    <div className="stack" style={{gap: 10}}>
      {errors.phases && <Notice tone="error" compact message={errors.phases} />}
      {phases.map((phase, index) => {
        const set = (key) => (next) => update(index, {...phase, [key]: next});
        const field = (name) => errors[`phases.${index}.${name}`];
        return (
          <section key={index} className="ry-phase" aria-label={`フェーズ${index + 1}`}>
            <div className="ry-phase-head">
              <h4>フェーズ{index + 1}</h4>
              {phases.length > 1 && <button type="button" className="text" disabled={disabled} onClick={() => remove(index)}>このフェーズを外す</button>}
            </div>
            <div className="on-form-grid">
              <FormField type="month" label="開始の計上月" required value={phase.startsMonth} onChange={set('startsMonth')} error={field('startsMonth')} disabled={disabled} />
              <FormField type="month" label="終了の計上月（以降ずっとなら空欄）" value={phase.endsMonth} onChange={set('endsMonth')} error={field('endsMonth')} disabled={disabled} />
              <FormField type="select" label="報告のサイクル（締め方）" required value={phase.preset} includeBlank={false} options={[...CYCLE_OPTIONS, ...extraPresets]}
                onChange={(next) => update(index, {...phase, preset: next, firstCloseImmediate: allowsFirstClose(next) ? phase.firstCloseImmediate : false})}
                error={field('cycleKind') || field('anchorMonth')} disabled={disabled} />
              {phase.preset === 'custom' && (
                <FormField type="text" label="締め月の一覧" required wide value={phase.customCloseMonths} onChange={set('customCloseMonths')} error={field('customCloseMonths')}
                  placeholder="例: 2026-06, 2026-12, 2027-09" hint="計上月以後で最初の締め月の報告書に入ります" disabled={disabled} />
              )}
              {allowsFirstClose(phase.preset) && (
                <label className="check on-field-wide">
                  <input type="checkbox" checked={phase.firstCloseImmediate} disabled={disabled} onChange={(event) => set('firstCloseImmediate')(event.target.checked)} />
                  <span>初月即締（開始月だけ開始月で締め、その後は選んだサイクル）</span>
                </label>
              )}
              {field('firstCloseImmediate') && <p className="on-field-error on-field-wide">{field('firstCloseImmediate')}</p>}
              {phase.preset === 'manual' && <p className="on-field-hint on-field-wide">別途協議: 自動では締めません。イレギュラーの台帳の「締め月の変更」で締め月を指定した計上月だけを報告書に入れます。</p>}
              {phase.preset === 'none' && <p className="on-field-hint on-field-wide">この期間の計上月はロイヤリティを発生させません。</p>}
            </div>
            {phase.preset !== 'none' && (
              <div className="two">
                <DueInput label="報告期限" value={phase.report} onChange={set('report')} disabled={disabled} />
                <DueInput label="支払期限" value={phase.payment} onChange={set('payment')} disabled={disabled} />
              </div>
            )}
            <FormField type="text" label="メモ" value={phase.note} onChange={set('note')} error={field('note')} disabled={disabled} />
          </section>
        );
      })}
      <div className="ry-actions">
        <button type="button" className="secondary" disabled={disabled}
          onClick={() => onChange([...phases, emptyPhase('')])}>＋フェーズを足す（途中でサイクルが変わるとき）</button>
      </div>
    </div>
  );
}

// 理由を入れて取り消す（2段の確認）。onConfirm(reason) は Promise を返す
export function ReasonAction({label, confirmTitle, confirmText, onConfirm, disabled = false, tone = 'warn', buttonClass = 'secondary'}) {
  const [step, setStep] = useState('idle');
  const [reason, setReason] = useState('');
  const [error, setError] = useState(null);
  if (step === 'idle') return <button type="button" className={buttonClass} disabled={disabled} onClick={() => setStep('edit')}>{label}</button>;
  async function run() {
    setStep('saving');
    setError(null);
    try {
      await onConfirm(reason.trim());
      setStep('idle');
      setReason('');
    } catch (cause) {
      setError(cause);
      setStep('confirm');
    }
  }
  return (
    <div className="stack" style={{gap: 8}}>
      {step === 'edit' && (
        <div className="ry-actions">
          <FormField type="text" label="理由" required wide value={reason} onChange={setReason} />
          <button type="button" disabled={!reason.trim()} onClick={() => setStep('confirm')}>内容を確かめる</button>
          <button type="button" className="text" onClick={() => { setStep('idle'); setReason(''); }}>やめる</button>
        </div>
      )}
      {step !== 'edit' && (
        <Notice tone={tone} title={confirmTitle} message={`${confirmText}（理由: ${reason}）`}
          actions={<>
            <button type="button" disabled={step === 'saving'} onClick={run}>{step === 'saving' ? '記録中…' : 'この内容で記録する'}</button>
            <button type="button" className="secondary" disabled={step === 'saving'} onClick={() => setStep('edit')}>戻って直す</button>
          </>} />
      )}
      <ErrorNotice error={error} />
    </div>
  );
}
