// 上部の「組織」。所属が2つ以上あるときだけ出す（1つなら何も描かない）。一覧を読めなかったときは、その旨と再試行を出す。
// 選択欄で選ぶだけでは切り替えず、「切り替える」を押したときだけ切り替える（Windows では閉じた選択欄で矢印キーを押すと
// change が起きるため、選択肢を見ただけで組織が変わりホームへ飛ぶのを防ぐ。WCAG 3.2.2）。CSS は AppShell が読む shell.css。
import React, {useEffect, useState} from 'react';
import {ORG_LIST_FAILED_MESSAGE, orgOptionLabel, orgSwitchTarget} from './org-model.mjs';

export function OrgSelector({orgs = [], currentOrgId, onSwitch, busy = false, error = '', listError = null, onRetryList}) {
  const [draft, setDraft] = useState(String(currentOrgId ?? ''));
  useEffect(() => { setDraft(String(currentOrgId ?? '')); }, [currentOrgId]);
  const list = Array.isArray(orgs) ? orgs : [];
  const listNotice = listError ? (
    <small className="app-org-error" role="alert">
      {ORG_LIST_FAILED_MESSAGE}
      {typeof onRetryList === 'function' && <button type="button" className="text" onClick={onRetryList}>再試行</button>}
    </small>
  ) : null;
  if (list.length < 2 || typeof onSwitch !== 'function') return listNotice ? <div className="app-org">{listNotice}</div> : null;
  const target = orgSwitchTarget(draft, currentOrgId);
  const submit = async (event) => {
    event.preventDefault();
    if (target === null || busy) return;
    // 未保存の確認で取りやめたときなどは、選択欄を今の組織に戻す
    if (await onSwitch(target) === false) setDraft(String(currentOrgId ?? ''));
  };
  return (
    <form className="app-org" onSubmit={submit}>
      <div className="app-org-row">
        <label className="app-org-field">
          <span>組織</span>
          <select value={draft} disabled={busy} onChange={(event) => setDraft(event.target.value)}>
            {list.map((org) => <option key={org.id} value={String(org.id)}>{orgOptionLabel(org)}</option>)}
          </select>
        </label>
        <button type="submit" className="secondary app-org-apply" disabled={busy || target === null}>切り替える</button>
      </div>
      {busy && <small className="app-org-status" role="status">切り替えています…</small>}
      {error && <small className="app-org-error" role="alert">{error}</small>}
      {listNotice}
    </form>
  );
}

export default OrgSelector;
