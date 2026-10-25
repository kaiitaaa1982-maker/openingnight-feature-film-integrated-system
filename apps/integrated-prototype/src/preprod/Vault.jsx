// プリプロの保管庫。構造化がすぐには難しい資料を、ファイルでもフォルダごとでも、まず全部置く（会社ルートの plans/2026-10-22-folder-preprod.md「保管庫」）。
// 落とすと名前と元のフォルダから種類を提案し、人は違うものだけ直して置く。原本は消せない。置き場を変えると行を足す。
import React, {useEffect, useMemo, useState} from 'react';
import {VAULT_CATEGORIES, suggestCategory, countByCategory} from './vault-model.mjs';

const LABEL = Object.fromEntries(VAULT_CATEGORIES.map((c) => [c.id, c.label]));
const toBase64 = (buffer) => { const bytes = new Uint8Array(buffer); let s = ''; for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000)); return btoa(s); };
const size = (n) => (n >= 1048576 ? `${(n / 1048576).toFixed(1)}MB` : `${Math.max(1, Math.round(n / 1024))}KB`);

export default function Vault({workId, request}) {
  const [docs, setDocs] = useState(null);
  const [maxBytes, setMaxBytes] = useState(12 * 1024 * 1024);
  const [cat, setCat] = useState('all');
  const [pending, setPending] = useState([]);
  const [busy, setBusy] = useState('');
  const [msg, setMsg] = useState('');
  const [reloadNo, setReloadNo] = useState(0);

  useEffect(() => {
    let alive = true;
    request(`/preprod/works/${workId}/documents`).then((r) => { if (alive) { setDocs(r.documents || []); if (r.maxBytes) setMaxBytes(r.maxBytes); } }).catch((e) => alive && setMsg(e.message || '読み込めませんでした'));
    return () => { alive = false; };
  }, [workId, request, reloadNo]);

  const counts = useMemo(() => countByCategory(docs || []), [docs]);
  const shown = (docs || []).filter((d) => cat === 'all' || d.category === cat);

  function add(files) {
    const rows = [...files].map((f) => {
      const path = f.webkitRelativePath || f.name;
      const folder = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '';
      return {file: f, path, folder, category: suggestCategory(path), tooBig: f.size > maxBytes};
    });
    setPending((p) => [...p, ...rows]);
  }

  async function placeAll() {
    setMsg('');
    let done = 0, dup = 0, failed = 0;
    for (const row of pending.filter((r) => !r.tooBig)) {
      setBusy(`置いています ${done + dup + failed + 1}/${pending.filter((r) => !r.tooBig).length}`);
      try {
        const base64 = toBase64(await row.file.arrayBuffer());
        const r = await request(`/preprod/works/${workId}/documents`, {method: 'POST', body: JSON.stringify({fileName: row.file.name, mediaType: row.file.type || null, base64, category: row.category, originPath: row.folder || null})});
        if (r.duplicate) dup += 1; else done += 1;
      } catch { failed += 1; }
    }
    setBusy('');
    setPending([]);
    setMsg(`置いた ${done}${dup ? `・同じ原本あり ${dup}（置き場だけ足した）` : ''}${failed ? `・置けなかった ${failed}` : ''}`);
    setReloadNo((n) => n + 1);
  }

  async function move(d, category) {
    try { await request(`/preprod/works/${workId}/documents/${d.document_id}/placements`, {method: 'POST', body: JSON.stringify({category, episode: d.episode, datedOn: d.dated_on, originPath: d.origin_path})}); setReloadNo((n) => n + 1); } catch (e) { setMsg(e.message || '置き場を変えられませんでした'); }
  }

  return (
    <div className="pp-vault">
      <nav className="pp-vault-cats">
        <button type="button" className={cat === 'all' ? 'on' : ''} onClick={() => setCat('all')}>全部 <span className="pp-num">{(docs || []).length}</span></button>
        {VAULT_CATEGORIES.map((c) => <button type="button" key={c.id} className={cat === c.id ? 'on' : ''} onClick={() => setCat(c.id)}>{c.label} <span className="pp-num">{counts[c.id] || ''}</span></button>)}
      </nav>
      <div className="pp-vault-main">
        <div className="pp-drop" onDragOver={(e) => e.preventDefault()} onDrop={(e) => { e.preventDefault(); add(e.dataTransfer.files); }}>
          <span>ここに落とす</span>
          <label className="pp-ghost-label">ファイル<input type="file" multiple onChange={(e) => { add(e.target.files); e.target.value = ''; }} /></label>
          <label className="pp-ghost-label">フォルダ<input type="file" multiple webkitdirectory="" directory="" onChange={(e) => { add(e.target.files); e.target.value = ''; }} /></label>
        </div>
        {pending.length > 0 && (
          <div className="pp-alert">
            <span className="pp-alert-h">{pending.length}</span>
            <table><thead><tr><th>ファイル</th><th>元の置き場</th><th>種類</th></tr></thead>
              <tbody>{pending.map((r, k) => <tr key={k}><td>{r.file.name}{r.tooBig ? <span className="pp-tag red"> {size(maxBytes)} 超</span> : ''}</td><td className="pp-sub">{r.folder}</td><td>
                <select value={r.category} onChange={(e) => setPending(pending.map((x, j) => (j === k ? {...x, category: e.target.value} : x)))}>{VAULT_CATEGORIES.map((c) => <option key={c.id} value={c.id}>{c.label}</option>)}</select></td></tr>)}</tbody></table>
            <div className="pp-form-act"><button type="button" className="on" disabled={Boolean(busy)} onClick={placeAll}>置く</button><button type="button" onClick={() => setPending([])}>やめる</button><span className="pp-sub">{busy}</span></div>
          </div>
        )}
        {msg && <p className="pp-sub">{msg}</p>}
        {docs == null ? <p className="pp-sub">読み込み中</p> : (
          <table><thead><tr><th>ファイル</th><th>種類</th><th>元の置き場</th><th>大きさ</th><th>受領</th><th></th></tr></thead>
            <tbody>{shown.map((d) => <tr key={d.document_id}>
              <td><a href={`/api/preprod/works/${workId}/documents/${d.document_id}/content`} target="_blank" rel="noreferrer">{d.file_name}</a></td>
              <td><select value={d.category} onChange={(e) => move(d, e.target.value)}>{VAULT_CATEGORIES.map((c) => <option key={c.id} value={c.id}>{c.label}</option>)}</select></td>
              <td className="pp-sub">{d.origins.join('・')}</td><td className="pp-num">{size(d.byte_length)}</td><td>{d.received_on}</td>
              <td>{d.category === 'contract' ? <span className="pp-tag">F16 へ</span> : null}</td></tr>)}
              </tbody></table>
        )}
      </div>
    </div>
  );
}

export {LABEL as VAULT_LABEL};
