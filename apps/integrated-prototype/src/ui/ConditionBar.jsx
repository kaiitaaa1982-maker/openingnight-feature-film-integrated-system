// 帳票の共通条件。条件は URL（useShell().getParam/setParam）に保存するので、戻る・再読込・リンク共有で同じ条件が再現する。
// 使い方: const values = useConditions(['fiscalYear','period','basis'], {fiscalStartMonth});
//         <ConditionBar conditions={[...]} values={values} works={...} partners={...} />
import React, {useMemo} from 'react';
import {useShell} from '../shell/context.mjs';
import {FormField} from './FormField.jsx';
import {EntityPicker} from './EntityPicker.jsx';
import {toEntityItems} from './entity-match.mjs';
import {
  readConditions, paramUpdates, fiscalYearOptions, fiscalRuleText, PERIOD_PRESETS, BASIS_OPTIONS, TAX_OPTIONS,
  DIRECTION_OPTIONS, AXIS_OPTIONS, CONDITION_LABELS, CONDITION_KEYS, isYm,
} from './condition-model.mjs';
import './forms.css';

export function useConditions(conditions = [], options = {}) {
  const shell = useShell();
  const keys = Object.values(CONDITION_KEYS).map((key) => `${key}=${shell.getParam(key, '') ?? ''}`).join('&');
  return useMemo(
    () => readConditions((key) => shell.getParam(key, null), conditions, options),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [keys, conditions.join(','), options.fiscalStartMonth, options.today, JSON.stringify(options.defaults || {}),
      (options.monthOptions || []).map((option) => option.value).join(','), (options.axisOptions || []).map((option) => option.value).join(',')],
  );
}

function Segmented({label, options, value, onChange, disabled}) {
  return (
    <div className="on-field">
      <span className="on-field-label">{label}</span>
      <div className="on-segmented" role="group" aria-label={label}>
        {options.map((option) => (
          <button key={option.value} type="button" aria-pressed={String(option.value) === String(value)} disabled={disabled}
            onClick={() => onChange(option.value)}>{option.label}</button>
        ))}
      </div>
    </div>
  );
}

export function ConditionBar({
  conditions = [], values, works = [], partners = [], distributionOptions = [], monthOptions, axisOptions = AXIS_OPTIONS,
  fiscalConfirmed = false, labels = {}, disabled = false, children, summary,
}) {
  const shell = useShell();
  const want = new Set(conditions);
  const startMonth = values?.fiscalStartMonth;
  const set = (name, value) => {
    for (const [key, next] of paramUpdates(name, value, values, {fiscalStartMonth: startMonth})) shell.setParam(key, next, {replace: true});
  };
  const label = (name) => labels[name] || CONDITION_LABELS[name];
  const workItems = useMemo(() => toEntityItems(works), [works]);
  const partnerItems = useMemo(() => toEntityItems(partners), [partners]);
  const yearOptions = fiscalYearOptions(values?.currentFiscalYear ?? new Date().getFullYear(), {extra: [values?.fiscalYear]});

  return (
    <section className="on-conditions" aria-label="帳票の条件">
      {(want.has('fiscalYear') || want.has('period')) && (
        <FormField type="select" label={label('fiscalYear')} value={String(values?.fiscalYear ?? '')} includeBlank={false} disabled={disabled}
          options={yearOptions} onChange={(value) => set('fiscalYear', value)} />
      )}
      {want.has('period') && (
        <FormField type="select" label={label('period')} value={values?.period ?? 'fy'} includeBlank={false} disabled={disabled}
          options={PERIOD_PRESETS.map((preset) => ({value: preset.id, label: preset.label}))} onChange={(value) => set('period', value)} />
      )}
      {want.has('period') && values?.period === 'custom' && (
        <>
          <FormField type="month" label="開始月" value={values.from ?? ''} disabled={disabled}
            onChange={(value) => { if (!value || isYm(value)) set('from', value); }} />
          <FormField type="month" label="終了月" value={values.to ?? ''} disabled={disabled}
            onChange={(value) => { if (!value || isYm(value)) set('to', value); }} />
        </>
      )}
      {want.has('month') && (
        monthOptions?.length
          ? <FormField type="select" label={label('month')} value={values?.month ?? ''} includeBlank={false} disabled={disabled}
            options={monthOptions} onChange={(value) => set('month', value)} />
          : <FormField type="month" label={label('month')} value={values?.month ?? ''} disabled={disabled}
            onChange={(value) => { if (!value || isYm(value)) set('month', value); }} />
      )}
      {want.has('direction') && (
        <Segmented label={label('direction')} options={DIRECTION_OPTIONS} value={values?.direction} disabled={disabled} onChange={(value) => set('direction', value)} />
      )}
      {want.has('basis') && (
        <Segmented label={label('basis')} options={BASIS_OPTIONS} value={values?.basis} disabled={disabled} onChange={(value) => set('basis', value)} />
      )}
      {want.has('tax') && (
        <Segmented label={label('tax')} options={TAX_OPTIONS} value={values?.tax} disabled={disabled} onChange={(value) => set('tax', value)} />
      )}
      {want.has('axis') && (
        <FormField type="select" label={label('axis')} value={values?.axis ?? ''} includeBlank={false} disabled={disabled}
          options={axisOptions} onChange={(value) => set('axis', value)} />
      )}
      {want.has('work') && (
        <EntityPicker label={label('work')} items={workItems} value={values?.workId ?? null} disabled={disabled}
          placeholder="すべての作品（コード・名称で絞込）" emptyText="すべての作品" className="on-field-wide" onChange={(value) => set('work', value)} />
      )}
      {want.has('partner') && (
        <EntityPicker label={label('partner')} items={partnerItems} value={values?.partnerId ?? null} disabled={disabled}
          placeholder="すべての取引先（コード・名称で絞込）" emptyText="すべての取引先" className="on-field-wide" onChange={(value) => set('partner', value)} />
      )}
      {want.has('distribution') && (
        <FormField type="select" label={label('distribution')} value={values?.distribution ?? ''} blankLabel="すべての流通" disabled={disabled}
          options={distributionOptions} onChange={(value) => set('distribution', value)} />
      )}
      {children}
      {(want.has('fiscalYear') || want.has('period')) && (
        <p className="on-conditions-rule">{fiscalRuleText(startMonth, {confirmed: fiscalConfirmed})}</p>
      )}
      {summary && <p className="on-conditions-summary">{summary}</p>}
      {values?.errors?.length > 0 && values.errors.map((message) => <p key={message} className="on-field-error on-conditions-summary">{message}</p>)}
    </section>
  );
}

export default ConditionBar;
