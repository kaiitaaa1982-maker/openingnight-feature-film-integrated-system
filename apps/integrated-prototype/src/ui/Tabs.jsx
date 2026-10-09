// 共通のタブ。urlKey を渡すと選択中のタブを外枠の URL 状態（useShell().getParam/setParam）に保存し、
// 戻る・再読込・共有で同じタブを開く。外枠（ShellProvider）が無くても手元の状態で動く。
// 使い方: <Tabs tabs={[{id:'a', label:'一覧', badge:3}]} urlKey="tab">{(active) => <Panel id={active}/>}</Tabs>
import React, {useId, useRef, useState} from 'react';
import {useShell} from '../shell/context.mjs';
import './data-grid.css';

const badgeVisible = (badge) => badge !== undefined && badge !== null && badge !== false && badge !== '';

// value を渡すと親が選択を持つ（onChange で受ける）。defaultValue は最初に開くタブ。
export function Tabs({tabs = [], value, defaultValue, onChange, urlKey, label = 'タブ', className = '', children}) {
  const shell = useShell();
  const baseId = useId();
  const listRef = useRef(null);
  const ids = tabs.map((tab) => tab.id);
  const [local, setLocal] = useState(() => defaultValue ?? value ?? ids[0]);
  const fromUrl = urlKey ? shell?.getParam?.(urlKey, null) : null;
  const urlTab = fromUrl === null || fromUrl === undefined || fromUrl === '' ? null : tabs.find((tab) => String(tab.id) === String(fromUrl));
  let current = urlTab ? urlTab.id : value ?? local;
  if (!ids.includes(current)) current = tabs.find((tab) => !tab.disabled)?.id ?? ids[0];

  function select(id) {
    if (id === current) return;
    setLocal(id);
    if (urlKey) shell?.setParam?.(urlKey, String(id), {replace: true});
    onChange?.(id);
  }

  function onKeyDown(event) {
    const enabled = tabs.filter((tab) => !tab.disabled).map((tab) => tab.id);
    if (!enabled.length) return;
    const index = enabled.indexOf(current);
    let next = null;
    if (event.key === 'ArrowRight') next = enabled[(index + 1) % enabled.length];
    else if (event.key === 'ArrowLeft') next = enabled[(index - 1 + enabled.length) % enabled.length];
    else if (event.key === 'Home') next = enabled[0];
    else if (event.key === 'End') next = enabled.at(-1);
    if (next === null) return;
    event.preventDefault();
    select(next);
    const position = ids.indexOf(next);
    listRef.current?.querySelectorAll('[role="tab"]')[position]?.focus();
  }

  const tabId = (id) => `${baseId}-tab-${id}`;
  const panelId = `${baseId}-panel`;
  const hasPanel = typeof children === 'function' || (children !== undefined && children !== null);
  return (
    <div className={`on-tabs ${className}`.trim()}>
      <div role="tablist" aria-label={label} className="on-tabs-list" ref={listRef} onKeyDown={onKeyDown}>
        {tabs.map((tab) => {
          const selected = tab.id === current;
          return (
            <button
              key={tab.id}
              type="button"
              role="tab"
              id={tabId(tab.id)}
              aria-selected={selected}
              aria-controls={hasPanel ? panelId : undefined}
              tabIndex={selected ? 0 : -1}
              disabled={tab.disabled}
              className="on-tab"
              onClick={() => select(tab.id)}
            >
              <span>{tab.label}</span>
              {badgeVisible(tab.badge) && <span className="on-tab-badge">{typeof tab.badge === 'number' ? tab.badge.toLocaleString('ja-JP') : tab.badge}</span>}
            </button>
          );
        })}
      </div>
      {hasPanel && (
        <div role="tabpanel" id={panelId} aria-labelledby={tabId(current)} className="on-tab-panel" tabIndex={-1}>
          {typeof children === 'function' ? children(current) : children}
        </div>
      )}
    </div>
  );
}

export default Tabs;
