import React, {useEffect, useMemo, useRef, useState} from 'react';
import {Notice} from '../ui/Notice.jsx';
import {buildSearch} from '../shell/url-state.mjs';
import {buildSourceTree} from './source-tree-model.mjs';
import {uploadFolders, defaultUploadFolder, uploadName, uploadKind, uploadRequestPath, uploadProblem, sha256HexOfBlob} from './source-upload-model.mjs';
import './source-tree.css';

const KINDS = {sales_report: '売上報告', contract: '契約', estimate: '見積', invoice: '請求', receipt: '領収',
  bank_statement: '口座明細', schedule: '予定', script: '台本', budget: '予算', planning_deck: '企画書',
  delivery_guide: '納品', media: '映像', image: '画像', audio: '音声', other: 'その他'};
const size = (bytes) => bytes >= 1024 ** 3 ? `${(bytes / 1024 ** 3).toFixed(1)} GB`
  : bytes >= 1024 ** 2 ? `${(bytes / 1024 ** 2).toFixed(1)} MB`
    : bytes >= 1024 ? `${(bytes / 1024).toFixed(1)} KB` : `${bytes} B`;

function Branches({nodes, selectedId, onSelect, depth = 0}) {
  return <ul className="source-tree-branches">
    {nodes.map((node) => <li key={node.id}>
      {node.type === 'folder' ? <details open={depth === 0 ? true : undefined}>
        <summary><span>{node.name}</span><span className="source-tree-count">{node.count}</span>
          {node.unlinkedCount > 0 && <span className="source-tree-unlinked">未 {node.unlinkedCount}</span>}</summary>
        <Branches nodes={node.children} selectedId={selectedId} onSelect={onSelect} depth={depth + 1} />
      </details> : <button type="button" className="source-tree-file" aria-pressed={selectedId === node.document.id}
        onClick={() => onSelect(node.document.id)}><span>{node.name}</span>
        {!node.document.linkedCount && <span className="source-tree-unlinked">未</span>}</button>}
    </li>)}
  </ul>;
}

// 画面から原本を足す（足すだけ。同じ名前・同じ中身があればサーバーが止める）。スマホは「撮る」でカメラ、「選ぶ」で写真・ファイル
function AddSource({request, folders, selectedLocation, onAdded, onExisting, onClose}) {
  const [folder, setFolder] = useState(() => defaultUploadFolder(folders, selectedLocation));
  const [file, setFile] = useState(null);
  const [name, setName] = useState('');
  const [kind, setKind] = useState('other');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const pick = (event) => {
    const picked = event.target.files?.[0];
    event.target.value = '';
    if (!picked) return;
    setFile(picked); setName(uploadName(picked.name)); setKind(uploadKind(picked.type)); setError(null);
  };
  const problem = file ? uploadProblem({folder, name: name.trim(), size: file.size}) : null;
  const send = async (event) => {
    event.preventDefault();
    if (!file || problem || busy) return;
    setBusy(true); setError(null);
    try {
      const sha256 = await sha256HexOfBlob(file);
      const made = await request(uploadRequestPath({folder, name: name.trim(), kind, mediaType: file.type}), {method: 'POST', body: file,
        headers: {'content-type': 'application/octet-stream', 'x-content-sha256': sha256}});
      onAdded({id: made.id, fileName: name.trim().normalize('NFC')});
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };
  const existingId = error?.status === 409 ? Number(error.details?.id) || null : null;
  return <form className="source-tree-add" onSubmit={send} aria-label="原本を足す">
    <label>置く先<select aria-label="置く先" value={folder} onChange={(e) => setFolder(e.target.value)}>
      {folders.map((f) => <option key={f.value} value={f.value}>{f.label}</option>)}</select></label>
    <div className="source-tree-pick">
      <label className="source-tree-pick-button">撮る<input type="file" accept="image/*" capture="environment" onChange={pick} /></label>
      <label className="source-tree-pick-button">選ぶ<input type="file" onChange={pick} /></label>
    </div>
    {file && <>
      <label>名前<input type="text" value={name} maxLength={240} onChange={(e) => setName(e.target.value)} /></label>
      <label>種類<select aria-label="種類" value={kind} onChange={(e) => setKind(e.target.value)}>
        {Object.entries(KINDS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
      <p className="source-tree-muted">{size(file.size)}</p>
    </>}
    {problem && <Notice tone="error" compact message={problem} />}
    {error && <Notice error={error} compact actions={existingId ? <button type="button" className="secondary" onClick={() => onExisting(existingId)}>見る</button> : null} />}
    <div className="source-tree-add-actions">
      <button type="submit" disabled={!file || Boolean(problem) || busy} aria-busy={busy}>{busy ? '送信中' : '足す'}</button>
      <button type="button" className="secondary" onClick={onClose} disabled={busy}>閉じる</button>
    </div>
  </form>;
}

export default function SourceTree({request, role}) {
  const [items, setItems] = useState(null);
  const [selectedId, setSelectedId] = useState(null);
  const [error, setError] = useState(null);
  const [revision, setRevision] = useState(0);
  const [adding, setAdding] = useState(false);
  const [added, setAdded] = useState([]);
  const selectNext = useRef(null);
  useEffect(() => {
    let active = true;
    setItems(null); setSelectedId(null); setError(null);
    request('/source-documents/tree').then((r) => { if (active) { setItems(r.items); setSelectedId(selectNext.current); selectNext.current = null; } })
      .catch((e) => { if (active) setError(e); });
    return () => { active = false; };
  }, [request, revision]);
  const tree = useMemo(() => buildSourceTree(items || []), [items]);
  const selected = items?.find((d) => d.id === selectedId);
  const folders = useMemo(() => uploadFolders(items || []), [items]);
  const canAdd = ['admin', 'editor'].includes(role) && folders.length > 0;
  const onAdded = (document) => { setAdded((list) => [document, ...list]); setAdding(false); selectNext.current = document.id; setRevision((n) => n + 1); };
  return <section className="source-tree">
    <div className="source-tree-head"><h2>原本の置き場</h2>
      {canAdd && !adding && <button type="button" className="source-tree-add-open" onClick={() => setAdding(true)}>＋原本</button>}</div>
    {canAdd && adding && <AddSource request={request} folders={folders} selectedLocation={selected?.location} onAdded={onAdded}
      onExisting={(id) => { setAdding(false); setSelectedId(id); }} onClose={() => setAdding(false)} />}
    {added.length > 0 && <ul className="source-tree-added" aria-label="足した原本">
      {added.map((d) => <li key={d.id}><span className="source-tree-added-mark">足した</span>
        <button type="button" className="source-tree-file" aria-pressed={selectedId === d.id} onClick={() => setSelectedId(d.id)}><span>{d.fileName}</span></button>
        <a className="source-tree-open" href={`/api/source-documents/${d.id}/content`} target="_blank" rel="noopener">開く</a></li>)}
    </ul>}
    {error && <Notice error={error} onRetry={() => setRevision((n) => n + 1)} retryLabel="再読込" />}
    {!items && !error && <p role="status" aria-busy="true">読込中</p>}
    {items && (items.length === 0 ? <p>原本なし</p> : <div className="source-tree-columns">
      <nav aria-label="原本のフォルダ"><Branches nodes={tree} selectedId={selectedId} onSelect={setSelectedId} /></nav>
      <div className="source-tree-detail" aria-label="原本の詳細">
        {selected ? <>
          <h3>{selected.fileName}</h3>
          <a className="source-tree-open" href={`/api/source-documents/${selected.id}/content`} target="_blank" rel="noopener">開く</a>
          <dl>
            <dt>場所</dt><dd>{selected.location || '場所なし'}</dd>
            <dt>SHA-256</dt><dd title={selected.sha256}>{selected.sha256.slice(0, 12)}…{selected.sha256.slice(-12)}</dd>
            <dt>大きさ</dt><dd title={`${selected.byteLength} B`}>{size(selected.byteLength)}</dd>
            <dt>種類</dt><dd>{KINDS[selected.kind] || selected.kind}</dd>
          </dl>
          <h3>この原本から作ったデータ</h3>
          {selected.unlinked ? <span className="source-tree-unlinked">未</span> : <ul className="source-tree-links">
            {selected.links.map((link) => <li key={link.table}>
              <div className="source-tree-link-heading"><span>{link.pageId}</span><span className="source-tree-count">{link.count}</span></div>
              <ul>{link.targets.map((target) => <li key={target.id}>
                <a href={buildSearch({page: link.pageId, workId: target.workId})}>{target.name}</a>
                <span className="source-tree-count">{target.count}</span>
              </li>)}</ul>
            </li>)}
          </ul>}
        </> : <p className="source-tree-muted">未選択</p>}
      </div>
    </div>)}
  </section>;
}
