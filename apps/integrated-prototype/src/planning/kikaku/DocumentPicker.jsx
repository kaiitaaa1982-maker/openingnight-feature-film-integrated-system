// 共通の置き場の原本を検索し、1件のIDを企画へ結ぶ。
import React, {useEffect, useState} from 'react';
import {Notice} from '../../ui/Notice.jsx';

export default function DocumentPicker({request, base, kind, extra, onLinked, onClose}) {
  const [query, setQuery] = useState('');
  const [items, setItems] = useState(null);
  const [selected, setSelected] = useState('');
  const [error, setError] = useState(null);
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    let active = true;
    setItems(null); setSelected(''); setError(null);
    request(`/source-documents?q=${encodeURIComponent(query)}`).then((r) => {
      if (active) setItems(r.items);
    }).catch((failure) => { if (active) setError(failure); });
    return () => { active = false; };
  }, [request, query]);
  const link = async () => {
    setSaving(true); setError(null);
    try {
      await request(`${base}/documents/link`, {method: 'POST', body: {documentId: Number(selected), kind, ...extra}});
      onLinked();
    } catch (failure) { setError(failure); }
    finally { setSaving(false); }
  };
  return <div className="kk-picker">
    <label className="kk-inline">検索<input type="search" aria-label="原本を検索" placeholder="ファイル名" value={query}
      disabled={saving} onChange={(e) => { setSelected(''); setItems(null); setQuery(e.target.value); }} /></label>
    {error && <Notice error={error} />}
    {!items && !error && <p aria-busy="true">読込中…</p>}
    {items && <>
      {items.length ? <label>原本<select aria-label="置き場の原本" size={Math.min(6, items.length + 1)} value={selected} disabled={saving}
        onChange={(e) => setSelected(e.target.value)}>
        <option value="">選ぶ</option>
        {items.map((d) => <option key={d.id} value={d.id}>{d.fileName} ｜ {d.receivedOn}{d.externalLocation ? ` ｜ ${d.externalLocation}` : ''}</option>)}
      </select></label> : <p>該当なし</p>}
      {items.length === 200 && <p className="kk-note">200件まで表示</p>}
    </>}
    <div className="kk-inline">
      <button type="button" className="kk-primary" disabled={!selected || saving} onClick={link}>{saving ? '処理中…' : '結び付ける'}</button>
      <button type="button" disabled={saving} onClick={onClose}>閉じる</button>
    </div>
  </div>;
}
