// 1件を登録・修正するフォーム。一覧の上の「＋新規登録」で開く折りたたみ（mode="create"）と、
// 詳細の中で使う修正フォーム（mode="edit"、折りたたまない）の2通り。
// - 必須に「必須」、空や変換できない値は保存時に項目の直下へ日本語の理由（parse-input の validateFields）。
// - 保存中はボタンを「保存中…」にして入力を止める。取り消せる保存なので確認ダイアログは出さない。
// - 「登録して続けて入力」は keep:true の項目を残して次の1件を入れられる。
// - 入力中は外枠の未保存保護（useShell().registerUnsaved）に登録する。閉じても入力は消さない。
// fields: [{name, label, type, required, domain, options, items（type=entity の候補）, hint, placeholder, defaultValue,
//           hidden, keep, wide, allowNegative, min, max, derived(values), validate(value, raw), visible(raw), emptyText}]
// onSubmit(values, {mode, continueAfter}) は保存を行い結果を返す（失敗は例外。ApiError の details は項目へ回す）。
import React, {useEffect, useId, useMemo, useRef, useState} from 'react';
import {useShell} from '../shell/context.mjs';
import {FormField} from './FormField.jsx';
import {EntityPicker} from './EntityPicker.jsx';
import {Notice} from './Notice.jsx';
import {ApiError, errorNotice, fieldErrorsFromDetails, messageFromBody} from './api-client.mjs';
import {validateFields, formatNumberInput} from './parse-input.mjs';
import './forms.css';

const NUMERIC = new Set(['yen', 'int', 'number']);

function initialRaw(fields, initialValues = {}) {
  const raw = {};
  for (const field of fields) {
    if (!field?.name) continue;
    const source = Object.hasOwn(initialValues, field.name) ? initialValues[field.name] : field.defaultValue;
    if (source === null || source === undefined) raw[field.name] = '';
    else if (NUMERIC.has(field.type) && typeof source === 'number') raw[field.name] = formatNumberInput(source);
    else raw[field.name] = source;
  }
  return raw;
}

const snapshot = (raw) => JSON.stringify(raw);

export function RecordForm({
  fields = [], onSubmit, onSaved, onCancel, mode = 'create', title, initialValues, collapsible = mode === 'create', defaultOpen = false,
  openLabel = '＋新規登録', submitLabel, continueLabel = '登録して続けて入力', allowContinue = mode === 'create', cancelLabel,
  successMessage, unsavedLabel, disabled = false, disabledReason = '閲覧専用の表示のため登録できません', resetKey, className = '',
}) {
  const shell = useShell();
  const readOnly = disabled || Boolean(shell?.readOnly);
  const formId = `rf${useId().replace(/:/g, '')}`;
  const base = useMemo(() => initialRaw(fields, initialValues), [resetKey, mode === 'edit' ? snapshot(initialValues || {}) : '']); // eslint-disable-line react-hooks/exhaustive-deps
  const [raw, setRaw] = useState(base);
  const [errors, setErrors] = useState({});
  const [formError, setFormError] = useState(null);
  const [notice, setNotice] = useState(null);
  const [saving, setSaving] = useState(false);
  const [open, setOpen] = useState(!collapsible || defaultOpen);
  const baseRef = useRef(base);

  // 作品の切替など resetKey が変わったら入力を初期値に戻す
  useEffect(() => {
    baseRef.current = base;
    setRaw(base);
    setErrors({});
    setFormError(null);
  }, [base]);

  const dirty = snapshot(raw) !== snapshot(baseRef.current);
  const registerUnsaved = shell?.registerUnsaved;
  const label = unsavedLabel || title || (mode === 'edit' ? '修正中の内容' : '新規登録の入力');
  useEffect(() => {
    registerUnsaved?.(formId, dirty ? 1 : 0, label);
  }, [dirty, formId, label, registerUnsaved]);
  useEffect(() => () => registerUnsaved?.(formId, 0, label), [formId, registerUnsaved]); // eslint-disable-line react-hooks/exhaustive-deps

  const preview = useMemo(() => validateFields(fields, raw), [fields, raw]);

  function change(name, value) {
    setRaw((previous) => ({...previous, [name]: value}));
    if (errors[name]) setErrors((previous) => ({...previous, [name]: undefined}));
    if (notice) setNotice(null);
  }

  function focusField(name) {
    const target = document.getElementById(`${formId}-${name}`);
    target?.focus?.();
  }

  async function submit(event, continueAfter = false) {
    event?.preventDefault?.();
    if (saving || readOnly) return;
    setNotice(null);
    const checked = validateFields(fields, raw);
    if (!checked.ok) {
      setErrors(checked.errors);
      setFormError({message: `${checked.order.length}項目を確認してください`});
      const first = checked.order.find((name) => !fields.find((field) => field.name === name)?.hidden);
      if (first) setTimeout(() => focusField(first), 0);
      return;
    }
    setErrors({});
    setFormError(null);
    setSaving(true);
    try {
      const result = await onSubmit?.(checked.values, {mode, continueAfter});
      if (result && typeof result === 'object' && result.ok === false) {
        throw new ApiError(messageFromBody(result) || '入力内容を確認してください', {status: 200, kind: 'validation', details: result.errors || result.details, body: result});
      }
      const message = typeof successMessage === 'function' ? successMessage(result, checked.values) : successMessage || (mode === 'edit' ? '保存しました' : '登録しました');
      if (mode === 'create') {
        const kept = {...base};
        if (continueAfter) for (const field of fields) if (field.keep) kept[field.name] = raw[field.name];
        baseRef.current = kept;
        setRaw(kept);
        if (!continueAfter && collapsible) setOpen(false);
      } else {
        baseRef.current = raw;
      }
      setNotice(message);
      onSaved?.(result, checked.values, {continued: continueAfter});
    } catch (error) {
      const mapped = fieldErrorsFromDetails(error?.details, fields);
      if (Object.keys(mapped.errors).length) setErrors(mapped.errors);
      setFormError(error);
    } finally {
      setSaving(false);
    }
  }

  function discard() {
    setRaw(baseRef.current);
    setErrors({});
    setFormError(null);
    if (mode === 'edit') onCancel?.();
    else if (collapsible) setOpen(false);
  }

  const visibleFields = fields.filter((field) => field?.name && !field.hidden && (!field.visible || field.visible(raw)));
  const bodyId = `${formId}-body`;
  const submitText = saving ? '保存中…' : submitLabel || (mode === 'edit' ? '保存' : '登録');
  const formNotice = formError && (formError instanceof Error
    ? <Notice error={formError} />
    : <Notice tone="error" message={formError.message} />);

  return (
    <div className={`on-record ${mode === 'edit' ? 'on-record-edit' : ''} ${className}`.trim()}>
      {collapsible && (
        <div className="on-record-head">
          <button type="button" className={open ? 'secondary' : ''} aria-expanded={open} aria-controls={bodyId}
            disabled={readOnly} onClick={() => setOpen((value) => !value)}>
            {open ? '入力欄を閉じる' : `${openLabel}${dirty ? '（入力中）' : ''}`}
          </button>
          {readOnly && <span className="on-field-hint">{disabledReason}</span>}
          {notice && !open && <Notice tone="ok" message={notice} compact onDismiss={() => setNotice(null)} />}
        </div>
      )}
      <form id={bodyId} className="on-record-form" noValidate hidden={collapsible && !open} onSubmit={(event) => submit(event, false)}
        aria-label={title || (mode === 'edit' ? '修正' : '新規登録')}>
        {title && <h3 className="on-record-title">{title}</h3>}
        <fieldset disabled={saving || readOnly} className="on-form-grid">
          {visibleFields.map((field) => {
            const id = `${formId}-${field.name}`;
            if (field.type === 'entity') {
              return (
                <EntityPicker key={field.name} id={id} name={field.name} label={field.label} required={field.required} items={field.items || []}
                  value={raw[field.name] === '' ? null : raw[field.name]} onChange={(value) => change(field.name, value ?? '')}
                  hint={field.hint} error={errors[field.name]} emptyText={field.emptyText} placeholder={field.placeholder} className={field.wide ? 'on-field-wide' : ''} />
              );
            }
            const derived = typeof field.derived === 'function';
            const value = derived ? (preview.values[field.name] ?? '') : raw[field.name];
            return (
              <FormField key={field.name} id={id} name={field.name} type={field.type || 'text'} label={field.label} required={field.required && !derived}
                value={derived && typeof value === 'number' ? formatNumberInput(value) : value} readOnly={derived || field.readOnly}
                onChange={(next) => change(field.name, next)} domain={field.domain} options={field.options} hint={derived ? field.hint || 'ほかの項目から計算します（入力不要）' : field.hint}
                placeholder={field.placeholder} error={errors[field.name]} allowNegative={field.allowNegative} wide={field.wide} rows={field.rows}
                blankLabel={field.blankLabel} showPreview={!derived} suggestions={field.suggestions} />
            );
          })}
        </fieldset>
        {formNotice}
        {notice && open && <Notice tone="ok" message={notice} compact onDismiss={() => setNotice(null)} />}
        <div className="on-form-actions">
          <button type="submit" disabled={saving || readOnly}>{submitText}</button>
          {allowContinue && mode === 'create' && (
            <button type="button" className="secondary" disabled={saving || readOnly} onClick={(event) => submit(event, true)}>{saving ? '保存中…' : continueLabel}</button>
          )}
          {(dirty || mode === 'edit') && (
            <button type="button" className="text" disabled={saving} onClick={discard}>
              {cancelLabel || (mode === 'edit' ? '修正をやめる' : '入力を消す')}
            </button>
          )}
        </div>
      </form>
    </div>
  );
}

export {errorNotice};
export default RecordForm;
