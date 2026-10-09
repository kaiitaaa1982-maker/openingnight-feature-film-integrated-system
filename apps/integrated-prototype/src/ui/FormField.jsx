// 入力欄1つ（ラベル・必須表示・補足・エラーを項目の直下に）。ui-guidelines §3「厳密さはシステム側が吸収する」。
// type: text | yen | int | date | month | datetime | select | textarea（email・url・search も text と同じ扱い）
// - yen・int は文字で入力させ、全角・カンマ・¥・円・空白を parse-input で吸収する。入力中は「12,000円として登録」を
//   下に示し、欄を離れたら桁区切りに整える。onChange には入力中の文字をそのまま渡す（保存時に parseFieldValue で数値化）。
// - select は domain を渡すと labels.mjs の日本語の選択肢、options:[{value,label}] を渡すとそれを使う。
// onChange(value, event) は値を第1引数で渡す（event ではない）。
import React, {useEffect, useId, useState} from 'react';
import {optionsOf, labelOf} from './labels.mjs';
import {parseYen, parseInteger, parseDate, parseMonth, formatNumberInput, isBlankInput} from './parse-input.mjs';
import './forms.css';

const NUMERIC = new Set(['yen', 'int', 'number']);

function numericText(value) {
  if (value === null || value === undefined) return '';
  if (typeof value === 'number') return formatNumberInput(value);
  return String(value);
}

function parseNumeric(type, text, allowNegative) {
  return type === 'yen' ? parseYen(text, {allowNegative}) : parseInteger(text, {allowNegative});
}

function dateValue(value) {
  if (isBlankInput(value)) return '';
  const parsed = parseDate(value);
  return parsed.ok && parsed.value ? parsed.value : '';
}

function monthValue(value) {
  if (isBlankInput(value)) return '';
  const parsed = parseMonth(value);
  return parsed.ok && parsed.value ? parsed.value : String(value);
}

export function selectOptions({domain, options}) {
  // group（見出し）を付けた選択肢は、同じ見出しの optgroup にまとめて出す（付けない呼び出し元は今までと同じ）
  if (Array.isArray(options)) return options.map((option) => (typeof option === 'object'
    ? {value: String(option.value ?? option.id ?? ''), label: option.label ?? String(option.value ?? ''), ...(option.group ? {group: String(option.group)} : {})}
    : {value: String(option), label: String(option)}));
  return domain ? optionsOf(domain) : [];
}

// 並びを保ったまま、同じ見出しが続く選択肢を1つの optgroup にまとめる
export function optionGroups(list = []) {
  const out = [];
  for (const option of list) {
    if (!option.group) { out.push({option}); continue; }
    const last = out.at(-1);
    if (last?.group === option.group) last.options.push(option);
    else out.push({group: option.group, options: [option]});
  }
  return out;
}

export function FormField({
  type = 'text', label, name, id: idProp, value, onChange, onBlur, required = false, error, hint, placeholder, disabled = false,
  readOnly = false, domain, options, includeBlank = true, blankLabel, allowNegative = false, rows = 4, autoFocus, className = '',
  wide = false, maxLength, describedBy, inputRef, showPreview = true, suggestions,
}) {
  const autoId = useId();
  const id = idProp || `f${autoId.replace(/:/g, '')}`;
  const [localError, setLocalError] = useState('');
  const [focused, setFocused] = useState(false);
  const hintId = hint ? `${id}-hint` : null;
  const errorText = error || localError;
  const errorId = errorText ? `${id}-error` : null;
  const numeric = NUMERIC.has(type);

  let preview = '';
  if (numeric && showPreview && !isBlankInput(value) && typeof value === 'string') {
    const parsed = parseNumeric(type, value, allowNegative);
    const canonical = parsed.ok && parsed.value !== null ? formatNumberInput(parsed.value) : null;
    if (canonical !== null && canonical !== value.trim()) preview = type === 'yen' ? `${canonical}円として登録` : `${canonical}として登録`;
  }
  // 欄を離れると値が「10,000」に整い、「…として登録」の行が消える。その行が消えて下のボタンが動くと、欄に居たまま押したクリックが空振りするので、
  // 一度出した行の高さは値を空にするまで残す（中身は空白）
  const [reservePreview, setReservePreview] = useState(false);
  useEffect(() => {
    if (preview && !reservePreview) setReservePreview(true);
    else if (!preview && reservePreview && isBlankInput(value)) setReservePreview(false);
  }, [preview, reservePreview, value]);
  const previewId = preview ? `${id}-preview` : null;
  const described = [hintId, previewId, errorId, describedBy].filter(Boolean).join(' ') || undefined;

  const emit = (next, event) => {
    if (localError) setLocalError('');
    onChange?.(next, event);
  };

  function handleBlur(event) {
    setFocused(false);
    const text = event.target.value;
    if (numeric && !isBlankInput(text)) {
      const parsed = parseNumeric(type, text, allowNegative);
      if (parsed.ok) {
        const formatted = formatNumberInput(parsed.value);
        if (formatted !== text) onChange?.(formatted, event);
      } else {
        setLocalError(parsed.error);
      }
    } else if (type === 'month' && !isBlankInput(text)) {
      const parsed = parseMonth(text);
      if (parsed.ok && parsed.value !== text) onChange?.(parsed.value, event);
      else if (!parsed.ok) setLocalError(parsed.error);
    }
    // 必須の空欄は、離れただけでは責めない（保存時に理由を出す）
    onBlur?.(event);
  }

  const common = {
    id, name, disabled, readOnly, autoFocus, ref: inputRef,
    'aria-invalid': errorText ? true : undefined,
    'aria-required': required || undefined,
    'aria-describedby': described,
    onBlur: handleBlur,
    onFocus: () => setFocused(true),
  };

  let control;
  if (type === 'select') {
    const list = selectOptions({domain, options});
    const current = value === null || value === undefined ? '' : String(value);
    const known = current === '' || list.some((option) => option.value === current);
    control = (
      <select {...common} value={current} onChange={(event) => emit(event.target.value, event)}>
        {includeBlank && <option value="">{blankLabel ?? (required ? '選択してください' : '未選択（未確認）')}</option>}
        {!known && <option value={current}>{domain ? labelOf(domain, current) : `未登録の値（${current}）`}</option>}
        {optionGroups(list).map((item) => (item.group
          ? <optgroup key={`g:${item.group}`} label={item.group}>{item.options.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</optgroup>
          : <option key={item.option.value} value={item.option.value}>{item.option.label}</option>))}
      </select>
    );
  } else if (type === 'textarea') {
    control = <textarea {...common} rows={rows} maxLength={maxLength} placeholder={placeholder} value={value ?? ''} onChange={(event) => emit(event.target.value, event)} />;
  } else if (numeric) {
    control = (
      <span className={`on-input-unit${type === 'yen' ? ' on-input-yen' : ''}`}>
        <input {...common} type="text" inputMode={allowNegative ? 'text' : 'numeric'} autoComplete="off" className="on-input-num"
          placeholder={placeholder ?? (type === 'yen' ? '例: 12,000' : '例: 1,200')} value={focused ? String(value ?? '') : numericText(value)}
          onChange={(event) => emit(event.target.value, event)} />
        {type === 'yen' && <span className="on-unit" aria-hidden="true">円</span>}
      </span>
    );
  } else if (type === 'date') {
    control = <input {...common} type="date" value={dateValue(value)} onChange={(event) => emit(event.target.value, event)} />;
  } else if (type === 'month') {
    control = <input {...common} type="month" placeholder={placeholder ?? '例: 2026-09'} value={monthValue(value)} onChange={(event) => emit(event.target.value, event)} />;
  } else if (type === 'datetime') {
    control = <input {...common} type="datetime-local" value={value ? String(value).slice(0, 16) : ''} onChange={(event) => emit(event.target.value, event)} />;
  } else {
    const inputType = ['email', 'url', 'search', 'tel'].includes(type) ? type : 'text';
    // suggestions: 自由入力の候補（既存の値など）。選ばずに新しい値を入れてもよい
    const listId = Array.isArray(suggestions) && suggestions.length ? `${id}-suggestions` : undefined;
    control = (
      <>
        <input {...common} type={inputType} maxLength={maxLength} placeholder={placeholder} value={value ?? ''} list={listId} onChange={(event) => emit(event.target.value, event)} />
        {listId && <datalist id={listId}>{suggestions.map((item) => <option key={item} value={item} />)}</datalist>}
      </>
    );
  }

  return (
    <div className={`on-field${wide || type === 'textarea' ? ' on-field-wide' : ''}${errorText ? ' on-field-invalid' : ''} ${className}`.trim()}>
      <label className="on-field-label" htmlFor={id}>
        <span>{label}</span>
        {required && <span className="on-req">必須</span>}
      </label>
      {control}
      {hint && <p id={hintId} className="on-field-hint">{hint}</p>}
      {preview ? <p id={previewId} className="on-field-preview">{preview}</p> : reservePreview ? <p className="on-field-preview" aria-hidden="true">{'\u00a0'}</p> : null}
      {errorText && <p id={errorId} className="on-field-error">{errorText}</p>}
    </div>
  );
}

export default FormField;
