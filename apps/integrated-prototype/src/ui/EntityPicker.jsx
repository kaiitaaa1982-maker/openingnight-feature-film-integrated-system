// 作品・取引先などを「コード・名称で検索して選ぶ」コンボボックス。候補の絞り込みは entity-match.mjs。
// 入力欄の下に「確定：名称（コード）」か「未確定」を常に出す。完全一致が1件なら自動で確定する。
// 使い方: <EntityPicker items={[{id, code, label, hint}]} value={id|null} onChange={(id, meta) => ...} label="作品" required />
// onChange の第2引数 meta.reason: 'select'（候補を選んだ）| 'exact'（完全一致で自動確定）| 'typing'（打ち直して未確定）
//   | 'clear'（空にした・解除）| 'restore'（Esc で直前の確定に戻した）。未確定の間 value は null。
import React, {useEffect, useId, useMemo, useRef, useState} from 'react';
import {matchEntities, exactMatch, findEntity, confirmationText, normalizeForMatch, MAX_CANDIDATES} from './entity-match.mjs';
import './forms.css';

export function EntityPicker({
  items = [], value = null, onChange, label, required = false, placeholder = 'コード・名称で検索', disabled = false,
  emptyText, hint, error, id: idProp, name, className = '', autoFocus,
}) {
  const autoId = useId().replace(/:/g, '');
  const id = idProp || `p${autoId}`;
  const listId = `${id}-list`;
  const statusId = `${id}-status`;
  const hintId = hint ? `${id}-hint` : null;
  const errorId = error ? `${id}-error` : null;
  const list = Array.isArray(items) ? items : [];
  const selected = findEntity(list, value);
  const [text, setText] = useState(selected?.label ?? '');
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const inputRef = useRef(null);
  const emitted = useRef(value);
  const lastConfirmed = useRef(selected);
  if (selected) lastConfirmed.current = selected;

  // 外から value が変わったとき（URL の戻る・既定値の設定など）と、候補の一覧が後から届いたときだけ入力欄を合わせる。
  // 自分が onChange で出した値の反映では、打ちかけの文字を消さない。
  useEffect(() => {
    const external = String(value ?? '') !== String(emitted.current ?? '');
    emitted.current = value;
    if (external) setText(selected?.label ?? '');
    else if (selected && !normalizeForMatch(text)) setText(selected.label ?? '');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value, selected?.label]);

  function emit(next, meta) {
    emitted.current = next;
    onChange?.(next, meta);
  }

  const showingSelected = selected && normalizeForMatch(text) === normalizeForMatch(selected.label);
  const query = showingSelected ? '' : text;
  const candidates = useMemo(() => matchEntities(list, query, {limit: MAX_CANDIDATES}), [list, query]);
  const totalMatches = useMemo(() => (query ? matchEntities(list, query, {limit: Infinity}).length : list.length), [list, query]);
  const activeIndex = Math.min(active, Math.max(0, candidates.length - 1));

  function choose(item) {
    setText(item.label ?? '');
    setOpen(false);
    setActive(0);
    if (String(item.id) !== String(value ?? '')) emit(item.id, {reason: 'select', item});
  }

  function handleInput(next) {
    setText(next);
    setOpen(true);
    setActive(0);
    const exact = exactMatch(list, next);
    if (exact) {
      if (String(exact.id) !== String(value ?? '')) emit(exact.id, {reason: 'exact', item: exact});
      return;
    }
    if (!normalizeForMatch(next)) {
      if (value !== null && value !== undefined) emit(null, {reason: 'clear'});
      return;
    }
    if (value !== null && value !== undefined) emit(null, {reason: 'typing'});
  }

  function clear() {
    setText('');
    setOpen(false);
    if (value !== null && value !== undefined) emit(null, {reason: 'clear'});
    inputRef.current?.focus();
  }

  function onKeyDown(event) {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      if (!open) setOpen(true);
      else setActive((index) => Math.min(index + 1, candidates.length - 1));
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      setActive((index) => Math.max(index - 1, 0));
    } else if (event.key === 'Enter') {
      if (open && candidates[activeIndex]) {
        event.preventDefault();
        choose(candidates[activeIndex]);
      }
    } else if (event.key === 'Escape') {
      if (open) {
        event.preventDefault();
        setOpen(false);
      } else if (!selected && lastConfirmed.current && text) {
        event.preventDefault();
        const previous = lastConfirmed.current;
        setText(previous.label ?? '');
        emit(previous.id, {reason: 'restore', item: previous});
      }
    } else if (event.key === 'Tab') {
      setOpen(false);
    }
  }

  const pending = !selected && Boolean(normalizeForMatch(text));
  const status = selected
    ? confirmationText(selected)
    : pending ? '未確定（候補から選んでください）' : (emptyText ?? '未確定');
  const statusTone = selected ? 'ok' : pending || required ? 'warn' : 'neutral';
  const invalid = Boolean(error) || (required && pending);
  const described = [statusId, hintId, errorId].filter(Boolean).join(' ');
  const optionId = (index) => `${id}-opt-${index}`;

  return (
    <div className={`on-field on-picker ${className}`.trim()}>
      <label className="on-field-label" htmlFor={id}>
        <span>{label}</span>
        {required && <span className="on-req">必須</span>}
      </label>
      <div className="on-picker-box">
        <input
          ref={inputRef}
          id={id}
          name={name}
          type="text"
          role="combobox"
          autoComplete="off"
          autoFocus={autoFocus}
          aria-autocomplete="list"
          aria-expanded={open}
          aria-controls={listId}
          aria-activedescendant={open && candidates.length ? optionId(activeIndex) : undefined}
          aria-describedby={described}
          aria-invalid={invalid || undefined}
          aria-required={required || undefined}
          placeholder={placeholder}
          disabled={disabled}
          value={text}
          onChange={(event) => handleInput(event.target.value)}
          onFocus={() => setOpen(true)}
          onClick={() => setOpen(true)}
          onBlur={() => setOpen(false)}
          onKeyDown={onKeyDown}
        />
        {text && !disabled && (
          <button type="button" className="text on-picker-clear" onMouseDown={(event) => event.preventDefault()} onClick={clear}
            aria-label={`${label ?? ''}の選択を解除`}>解除</button>
        )}
        {open && !disabled && (
          <ul id={listId} role="listbox" className="on-picker-list" aria-label={`${label ?? ''}の候補`}>
            {candidates.map((item, index) => (
              <li key={String(item.id)} id={optionId(index)} role="option" aria-selected={index === activeIndex}
                className={`on-picker-option${index === activeIndex ? ' on-picker-active' : ''}${String(item.id) === String(value ?? '') ? ' on-picker-current' : ''}`}
                onMouseDown={(event) => event.preventDefault()} onMouseEnter={() => setActive(index)} onClick={() => choose(item)}>
                <span className="on-picker-label">{item.label || item.code}</span>
                {item.code && item.code !== item.label && <span className="on-picker-code">{item.code}</span>}
                {item.hint && <span className="on-picker-hint">{item.hint}</span>}
              </li>
            ))}
            {!candidates.length && <li className="on-picker-empty" role="presentation">該当する候補がありません</li>}
            {totalMatches > candidates.length && (
              <li className="on-picker-more" role="presentation">
                該当{totalMatches.toLocaleString('ja-JP')}件のうち{candidates.length}件を表示しています。続けて入力すると絞り込めます
              </li>
            )}
          </ul>
        )}
      </div>
      <p id={statusId} className={`on-picker-status on-picker-${statusTone}`} aria-live="polite">{status}</p>
      {hint && <p id={hintId} className="on-field-hint">{hint}</p>}
      {error && <p id={errorId} className="on-field-error">{error}</p>}
    </div>
  );
}

// 未確定のまま実行させないための判定（入力はあるが確定していない）。
export function isPickerPending(items, value, text) {
  return !findEntity(items, value) && Boolean(normalizeForMatch(text));
}

export default EntityPicker;
