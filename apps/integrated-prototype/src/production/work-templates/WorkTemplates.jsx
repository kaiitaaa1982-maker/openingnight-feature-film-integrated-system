// 業務ひな型の画面（移行 0057。要件 docs/requirements/production/work-templates.md）。見た目は docs/design/integrated-system-visual.md。
// フォルダ（業務の種類）の一覧 → フォルダの中のひな型 → 1通（穴を埋める・原本・版・直す）。画面内での Office の編集は作らない
import React, {useCallback, useEffect, useMemo, useState} from 'react';
import {Notice} from '../../ui/Notice.jsx';
import {BLOCK_KINDS, VARIABLE_KINDS, blocksToText, missingRequired, resolveBlocks} from './work-templates-model.mjs';
import './work-templates.css';

const BLOCK_LABELS = {heading: '見出し', text: '本文', checklist: 'チェックリスト', fields: '項目の表', table: '表'};
const VARIABLE_LABELS = {text: '1行の文字', longtext: '長い文字', number: '数', date: '日付', time: '時刻', url: 'リンク', choice: '選ぶ'};
const OP_LABELS = {filled: '入っているとき', empty: '空のとき', equals: 'と同じとき', not_equals: 'と違うとき'};
const SOURCE_LABELS = {document: '資料', message: 'メッセージ', sheet: '表', verbal: '口頭', other: 'その他', unverified: '未確認'};
const ACCEPT = '.docx,.xlsx,.pptx';
const jst = (value) => {
  const at = new Date(`${String(value).replace(' ', 'T')}Z`);
  return Number.isNaN(at.getTime()) ? '' : new Date(at.getTime() + 9 * 3600 * 1000).toISOString().slice(0, 16).replace('T', ' ');
};
const size = (n) => (n >= 1048576 ? `${(n / 1048576).toFixed(1)}MB` : `${Math.max(1, Math.round(n / 1024))}KB`);
const readAsBase64 = (blob) => new Promise((resolve, reject) => {
  const reader = new FileReader();
  reader.onload = () => resolve(String(reader.result).split(',')[1] ?? '');
  reader.onerror = () => reject(reader.error ?? new Error('ファイルを読めません'));
  reader.readAsDataURL(blob);
});
const post = (request, path, payload) => request(path, {method: 'POST', body: JSON.stringify(payload)});

function Field({label, children}) {
  return <label className="wt-field">{label}{children}</label>;
}

// ---- 条件（この穴が…のときだけ出す） ----
function Cond({when, variables, onChange}) {
  if (!variables.length) return null;
  const value = when || {key: '', op: 'filled'};
  const set = (patch) => { const next = {...value, ...patch}; onChange(next.key ? next : null); };
  return <span className="wt-cond">
    <select aria-label="条件の穴" value={value.key} onChange={(e) => set({key: e.target.value})}><option value="">条件なし</option>{variables.map((v) => <option key={v.key} value={v.key}>{v.label || v.key}</option>)}</select>
    {value.key && <select aria-label="条件の種類" value={value.op} onChange={(e) => set({op: e.target.value})}>{Object.entries(OP_LABELS).map(([op, label]) => <option key={op} value={op}>{label}</option>)}</select>}
    {value.key && (value.op === 'equals' || value.op === 'not_equals') && <input aria-label="条件の値" value={value.value ?? ''} onChange={(e) => set({value: e.target.value})} />}
  </span>;
}

// ---- 部品の編集 ----
const newBlock = (kind) => ({
  heading: {kind, text: ''}, text: {kind, text: ''}, checklist: {kind, title: '', items: [{text: ''}]},
  fields: {kind, title: '', rows: [{label: '', value: ''}]}, table: {kind, title: '', columns: ['', ''], rows: [{cells: ['', '']}]},
}[kind]);

function BlockEditor({block, variables, onChange, onMove, onRemove}) {
  const patch = (next) => onChange({...block, ...next});
  const setRow = (list, index, next) => list.map((row, i) => (i === index ? {...row, ...next} : row));
  const rowsKey = block.kind === 'checklist' ? 'items' : 'rows';
  const addRow = () => patch({[rowsKey]: [...block[rowsKey], block.kind === 'checklist' ? {text: ''} : block.kind === 'fields' ? {label: '', value: ''} : {cells: block.columns.map(() => '')}]});
  const delRow = (i) => block[rowsKey].length > 1 && patch({[rowsKey]: block[rowsKey].filter((_, k) => k !== i)});
  return <div className="wt-block">
    <header>
      <span><span className="wt-tag">{BLOCK_LABELS[block.kind]}</span> <Cond when={block.when} variables={variables} onChange={(when) => patch({when: when || undefined})} /></span>
      <span className="wt-row"><button type="button" onClick={() => onMove(-1)} aria-label="上へ">↑</button><button type="button" onClick={() => onMove(1)} aria-label="下へ">↓</button><button type="button" onClick={onRemove}>外す</button></span>
    </header>
    {block.kind === 'heading' && <input aria-label="見出し" value={block.text} onChange={(e) => patch({text: e.target.value})} />}
    {block.kind === 'text' && <textarea aria-label="本文" rows={4} value={block.text} onChange={(e) => patch({text: e.target.value})} />}
    {(block.kind === 'checklist' || block.kind === 'fields' || block.kind === 'table') && <input aria-label="題" placeholder="題（なくてもよい）" value={block.title ?? ''} onChange={(e) => patch({title: e.target.value})} />}
    {block.kind === 'table' && <div className="wt-row">{block.columns.map((col, i) => <input key={i} aria-label={`列${i + 1}`} value={col} onChange={(e) => patch({columns: block.columns.map((c, k) => (k === i ? e.target.value : c))})} />)}
      <button type="button" onClick={() => patch({columns: [...block.columns, ''], rows: block.rows.map((r) => ({...r, cells: [...r.cells, '']}))})}>列＋</button>
      {block.columns.length > 1 && <button type="button" onClick={() => patch({columns: block.columns.slice(0, -1), rows: block.rows.map((r) => ({...r, cells: r.cells.slice(0, -1)}))})}>列－</button>}</div>}
    {block[rowsKey]?.map((row, i) => <div key={i} className="wt-row">
      {block.kind === 'checklist' && <input className="wt-grow" aria-label={`項目${i + 1}`} value={row.text} onChange={(e) => patch({items: setRow(block.items, i, {text: e.target.value})})} />}
      {block.kind === 'fields' && <><input aria-label={`名前${i + 1}`} placeholder="名前" value={row.label} onChange={(e) => patch({rows: setRow(block.rows, i, {label: e.target.value})})} /><input className="wt-grow" aria-label={`値${i + 1}`} placeholder="値（{{キー}}で穴）" value={row.value} onChange={(e) => patch({rows: setRow(block.rows, i, {value: e.target.value})})} /></>}
      {block.kind === 'table' && row.cells.map((cell, j) => <input key={j} aria-label={`行${i + 1}列${j + 1}`} value={cell} onChange={(e) => patch({rows: setRow(block.rows, i, {cells: row.cells.map((c, k) => (k === j ? e.target.value : c))})})} />)}
      <Cond when={row.when} variables={variables} onChange={(when) => patch({[rowsKey]: setRow(block[rowsKey], i, {when: when || undefined})})} />
      <button type="button" onClick={() => delRow(i)} aria-label={`${i + 1}行目を外す`}>－</button>
    </div>)}
    {block[rowsKey] && <div><button type="button" onClick={addRow}>行を足す</button></div>}
  </div>;
}

function VariableEditor({variables, onChange}) {
  const set = (index, next) => onChange(variables.map((v, i) => (i === index ? {...v, ...next} : v)));
  return <div className="wt-box soft">
    <h3>穴（本文の {'{{キー}}'} に入る値）</h3>
    {variables.map((v, i) => <div key={i} className="wt-row">
      <input aria-label={`穴${i + 1}のキー`} placeholder="キー（英小文字）" value={v.key} onChange={(e) => set(i, {key: e.target.value})} />
      <input aria-label={`穴${i + 1}の名前`} placeholder="名前" value={v.label} onChange={(e) => set(i, {label: e.target.value})} />
      <select aria-label={`穴${i + 1}の種類`} value={v.kind} onChange={(e) => set(i, {kind: e.target.value})}>{VARIABLE_KINDS.map((k) => <option key={k} value={k}>{VARIABLE_LABELS[k]}</option>)}</select>
      {v.kind === 'choice' && <input aria-label={`穴${i + 1}の選択肢`} placeholder="選択肢（、で区切る）" value={(v.options ?? []).join('、')} onChange={(e) => set(i, {options: e.target.value.split(/[、,]/).map((o) => o.trim()).filter(Boolean)})} />}
      <label><input type="checkbox" checked={v.required === true} onChange={(e) => set(i, {required: e.target.checked})} /> 必須</label>
      <button type="button" onClick={() => onChange(variables.filter((_, k) => k !== i))}>外す</button>
    </div>)}
    <div><button type="button" onClick={() => onChange([...variables, {key: '', label: '', kind: 'text', required: false}])}>穴を足す</button></div>
  </div>;
}

// 送る前に、空の条件や選択肢を整える
const tidy = (draft) => ({
  name: draft.name, purpose: draft.purpose, scene: draft.scene, driveRef: draft.driveRef, source: draft.source, variables: draft.variables.map((v) => (v.kind === 'choice' ? v : (({options, ...rest}) => rest)(v))),
  blocks: draft.blocks, retired: draft.retired === true, reason: draft.reason,
});
const emptyDraft = () => ({name: '', purpose: '', scene: '', driveRef: '', source: {kind: 'unverified', note: '', origin: ''}, variables: [], blocks: [], retired: false, reason: ''});

function Editor({draft, setDraft, isNew, busy, onSubmit, onCancel}) {
  const set = (patch) => setDraft({...draft, ...patch});
  const [kind, setKind] = useState('text');
  const blocks = draft.blocks;
  const move = (i, d) => { const j = i + d; if (j < 0 || j >= blocks.length) return; const next = [...blocks]; [next[i], next[j]] = [next[j], next[i]]; set({blocks: next}); };
  return <form className="wt-box" onSubmit={(e) => { e.preventDefault(); onSubmit(); }}>
    <h3>{isNew ? 'ひな型を作る' : '新しい版にする'}</h3>
    <Field label="名前"><input required maxLength={120} value={draft.name} onChange={(e) => set({name: e.target.value})} /></Field>
    <Field label="何のためか"><input maxLength={500} value={draft.purpose} onChange={(e) => set({purpose: e.target.value})} /></Field>
    <Field label="使う場面"><input maxLength={500} value={draft.scene} onChange={(e) => set({scene: e.target.value})} /></Field>
    <div className="wt-row">
      <Field label="出どころ"><select value={draft.source.kind} onChange={(e) => set({source: {...draft.source, kind: e.target.value}})}>{Object.entries(SOURCE_LABELS).map(([k, label]) => <option key={k} value={k}>{label}</option>)}</select></Field>
      <div className="wt-grow"><Field label="出どころの名前"><input value={draft.source.origin ?? ''} onChange={(e) => set({source: {...draft.source, origin: e.target.value}})} /></Field></div>
      <div className="wt-grow"><Field label="Google ドライブのファイル ID かリンク（任意）"><input value={draft.driveRef} onChange={(e) => set({driveRef: e.target.value})} /></Field></div>
    </div>
    <Field label="出どころのメモ"><input maxLength={1000} value={draft.source.note ?? ''} onChange={(e) => set({source: {...draft.source, note: e.target.value}})} /></Field>
    <VariableEditor variables={draft.variables} onChange={(variables) => set({variables})} />
    {blocks.map((block, i) => <BlockEditor key={i} block={block} variables={draft.variables} onChange={(next) => set({blocks: blocks.map((b, k) => (k === i ? next : b))})} onMove={(d) => move(i, d)} onRemove={() => set({blocks: blocks.filter((_, k) => k !== i)})} />)}
    <div className="wt-row"><select aria-label="足す部品" value={kind} onChange={(e) => setKind(e.target.value)}>{BLOCK_KINDS.map((k) => <option key={k} value={k}>{BLOCK_LABELS[k]}</option>)}</select><button type="button" onClick={() => set({blocks: [...blocks, newBlock(kind)]})}>部品を足す</button></div>
    {!isNew && <Field label="直した理由（必須）"><input required maxLength={500} value={draft.reason} onChange={(e) => set({reason: e.target.value})} /></Field>}
    {!isNew && <label><input type="checkbox" checked={draft.retired} onChange={(e) => set({retired: e.target.checked})} /> このひな型をやめる（一覧から外す。版は残る）</label>}
    <div className="wt-row"><button className="on" type="submit" disabled={busy}>{isNew ? '作る' : '新しい版にする'}</button><button type="button" onClick={onCancel}>やめる</button></div>
  </form>;
}

// ---- 穴を埋める ----
function FillPanel({version}) {
  const [values, setValues] = useState({});
  const [copied, setCopied] = useState(false);
  const resolved = useMemo(() => resolveBlocks(version.blocks, values, version.variables), [version, values]);
  const missing = missingRequired(version.variables, values);
  if (!version.blocks.length) return null;
  return <section className="wt-box">
    <h3>使う（穴を埋める）</h3>
    {version.variables.length > 0 && <div className="wt-row">{version.variables.map((v) => <div key={v.key} className="wt-grow"><Field label={`${v.label}${v.required ? '（必須）' : ''}`}>
      {v.kind === 'choice' ? <select value={values[v.key] ?? ''} onChange={(e) => setValues({...values, [v.key]: e.target.value})}><option value="" />{v.options.map((o) => <option key={o} value={o}>{o}</option>)}</select>
        : v.kind === 'longtext' ? <textarea rows={3} value={values[v.key] ?? ''} onChange={(e) => setValues({...values, [v.key]: e.target.value})} />
          : <input type={{number: 'number', date: 'date', time: 'time', url: 'url'}[v.kind] || 'text'} placeholder={v.example ?? ''} value={values[v.key] ?? ''} onChange={(e) => setValues({...values, [v.key]: e.target.value})} />}
    </Field></div>)}</div>}
    {missing.length > 0 && <p className="wt-sub wt-stop">未入力の必須: {missing.map((v) => v.label).join('、')}</p>}
    <div className="wt-out">
      {resolved.map((b, i) => <div key={i}>
        {b.kind === 'heading' && <h4>{b.text}</h4>}
        {b.kind === 'text' && <p>{b.text}</p>}
        {b.kind === 'checklist' && <>{b.title && <h4>{b.title}</h4>}<ul>{b.items.map((it, k) => <li key={k}>□ {it.text}</li>)}</ul></>}
        {b.kind === 'fields' && <>{b.title && <h4>{b.title}</h4>}<table><tbody>{b.rows.map((r, k) => <tr key={k}><th>{r.label}</th><td>{r.value}</td></tr>)}</tbody></table></>}
        {b.kind === 'table' && <>{b.title && <h4>{b.title}</h4>}<table><thead><tr>{b.columns.map((c, k) => <th key={k}>{c}</th>)}</tr></thead><tbody>{b.rows.map((r, k) => <tr key={k}>{r.cells.map((c, j) => <td key={j}>{c}</td>)}</tr>)}</tbody></table></>}
      </div>)}
    </div>
    <div className="wt-row"><button type="button" onClick={async () => { try { await navigator.clipboard.writeText(blocksToText(resolved)); setCopied(true); } catch { setCopied(false); } }}>文字としてコピー</button>{copied && <span className="wt-tag">コピーしました</span>}</div>
  </section>;
}

// ---- 原本（Word・Excel・PowerPoint） ----
function Files({request, detail, onChanged, setMessage}) {
  const [file, setFile] = useState(null);
  const [reason, setReason] = useState('');
  const [driveRef, setDriveRef] = useState('');
  const [busy, setBusy] = useState(false);
  const latest = detail.files[0];
  const upload = async (e) => {
    e.preventDefault(); if (!file) return;
    setBusy(true); setMessage('');
    try {
      await post(request, `/work-templates/templates/${detail.template.id}/files`, {fileName: file.name, base64: await readAsBase64(file), driveRef, reason, expectedFileNo: latest ? latest.file_no : 0});
      setFile(null); setReason(''); setDriveRef(''); e.target.reset(); await onChanged();
    } catch (error) { setMessage(error.message); } finally { setBusy(false); }
  };
  const [q, setQ] = useState('');
  const [found, setFound] = useState(null);
  const search = async (e) => {
    e.preventDefault(); setMessage('');
    if (!q.trim()) { setFound(null); return; }
    try { setFound((await request(`/work-templates/source-candidates?q=${encodeURIComponent(q.trim())}`)).documents); } catch (error) { setMessage(error.message); }
  };
  const link = async (documentId) => {
    setBusy(true); setMessage('');
    try {
      await post(request, `/work-templates/templates/${detail.template.id}/files`, {documentId, driveRef, reason, expectedFileNo: latest ? latest.file_no : 0});
      setFound(null); setQ(''); setReason(''); setDriveRef(''); await onChanged();
    } catch (error) { setMessage(error.message); } finally { setBusy(false); }
  };
  return <section className="wt-box">
    <h3>原本（Word・Excel・PowerPoint）</h3>
    {detail.files.length > 0 ? <table><thead><tr><th>置いた版</th><th>ファイル</th><th>大きさ</th><th>置いた日</th><th>理由</th><th>Google ドライブ</th><th /></tr></thead>
      <tbody>{detail.files.map((f, i) => <tr key={f.id}><td className="num">{f.file_no}{i === 0 && <> <span className="wt-tag">最新</span></>}</td><td>{f.file_name}</td><td className="num">{size(f.byte_length)}</td><td>{jst(f.created_at)}</td><td>{f.reason || '—'}</td><td>{f.drive_ref ? <span className="wt-sub">{f.drive_ref}</span> : '—'}</td><td>{f.storage === 'external' ? <span className="wt-sub"><span className="wt-tag weak">R2</span> {f.location}</span> : <a href={`/api/work-templates/files/${f.id}/download`}>ダウンロード</a>}</td></tr>)}</tbody></table>
      : <p className="wt-sub">原本はまだありません</p>}
    <form className="wt-row" onSubmit={upload}>
      <input type="file" accept={ACCEPT} aria-label="原本のファイル" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
      {latest && <input required aria-label="置き直す理由" placeholder="置き直す理由（必須）" value={reason} onChange={(e) => setReason(e.target.value)} />}
      <input aria-label="Google ドライブのファイル ID かリンク（任意）" placeholder="Google ドライブの ID かリンク（任意）" value={driveRef} onChange={(e) => setDriveRef(e.target.value)} />
      <button className="on" type="submit" disabled={busy || !file}>{latest ? '置き直す' : '置く'}</button>
    </form>
    <form className="wt-row" onSubmit={search}>
      <input className="wt-grow" aria-label="取り込み済みの原本を探す" placeholder="取り込み済み（R2 など）の原本を名前・場所で探す" value={q} onChange={(e) => setQ(e.target.value)} />
      <button type="submit">探す</button>
    </form>
    {found && (found.length === 0 ? <p className="wt-sub">見つかりません</p>
      : <table><tbody>{found.map((d) => <tr key={d.id}><td>{d.file_name}</td><td className="num">{size(d.byte_length)}</td><td>{d.location ? <span className="wt-sub"><span className="wt-tag weak">R2</span> {d.location}</span> : '画面から置いた原本'}</td>
        <td><button type="button" disabled={busy || (latest && !reason)} onClick={() => link(d.id)}>結ぶ</button></td></tr>)}</tbody></table>)}
    <p className="wt-sub">docx・xlsx・pptx、{size(detail.maxBytes)}まで。置き直すと版が増え、古い原本も残る</p>
  </section>;
}

// ---- 1通 ----
function TemplateView({request, templateId, onBack, onOpen, folders, setMessage}) {
  const [detail, setDetail] = useState(null);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(emptyDraft());
  const [busy, setBusy] = useState(false);
  const [copyTo, setCopyTo] = useState(null);
  const [moveTo, setMoveTo] = useState(null);
  const [moveReason, setMoveReason] = useState('');
  const load = useCallback(async () => {
    try { setDetail(await request(`/work-templates/templates/${templateId}`)); } catch (error) { setMessage(error.message); }
  }, [request, templateId, setMessage]);
  useEffect(() => { setDetail(null); setEditing(false); load(); }, [load]);
  if (!detail) return <p className="wt-sub">読み込み中</p>;
  const {template, versions, files, moves} = detail;
  const latest = versions[0];
  const startEdit = (retire = false) => {
    setDraft({name: latest.name, purpose: latest.purpose ?? '', scene: latest.scene ?? '', driveRef: latest.drive_ref ?? '', source: {kind: latest.source.kind, note: latest.source.note ?? '', origin: latest.source.origin ?? ''},
      variables: JSON.parse(JSON.stringify(latest.variables)), blocks: JSON.parse(JSON.stringify(latest.blocks)), retired: retire, reason: ''});
    setEditing(true);
  };
  const submit = async () => {
    setBusy(true); setMessage('');
    try { await post(request, `/work-templates/templates/${template.id}/versions`, {...tidy(draft), expectedVersion: template.version_no}); setEditing(false); await load(); } catch (error) { setMessage(error.message); } finally { setBusy(false); }
  };
  const copy = async (folderId) => {
    setBusy(true); setMessage('');
    try { const out = await post(request, `/work-templates/templates/${template.id}/copy`, {folderId}); onOpen(out.id); } catch (error) { setMessage(error.message); } finally { setBusy(false); }
  };
  const targets = folders.filter((f) => !f.retired && f.id !== template.folder_id);
  const move = async () => {
    const folderId = moveTo ?? targets[0]?.id; if (!folderId) return;
    setBusy(true); setMessage('');
    try { await post(request, `/work-templates/templates/${template.id}/move`, {folderId, reason: moveReason, expectedMoveNo: template.move_no}); setMoveTo(null); setMoveReason(''); await load(); } catch (error) { setMessage(error.message); } finally { setBusy(false); }
  };
  return <>
    <div className="wt-bar"><div><div className="wt-crumb"><button type="button" onClick={onBack}>{template.folder_name}</button></div><h2>{latest.name} <span className="wt-tag">第{template.version_no}版</span>{template.retired && <> <span className="wt-tag">やめた</span></>}</h2></div>
      <div className="wt-row"><button type="button" onClick={() => startEdit(false)} disabled={editing}>直す</button>
        <button type="button" onClick={() => startEdit(!template.retired)} disabled={editing}>{template.retired ? '戻す' : 'やめる'}</button>
        <select aria-label="複製先のフォルダ" value={copyTo ?? template.folder_id} onChange={(e) => setCopyTo(Number(e.target.value))}>{folders.filter((f) => !f.retired).map((f) => <option key={f.id} value={f.id}>{f.name}</option>)}</select>
        <button type="button" disabled={busy} onClick={() => copy(copyTo ?? template.folder_id)}>複製する</button></div></div>
    {!editing && <section className="wt-box"><h3>フォルダを移す</h3>
      <div className="wt-row"><select aria-label="移し先のフォルダ" value={moveTo ?? targets[0]?.id ?? ''} onChange={(e) => setMoveTo(Number(e.target.value))} disabled={!targets.length}>{targets.map((f) => <option key={f.id} value={f.id}>{f.name}</option>)}</select>
        <input className="wt-grow" aria-label="移す理由（任意）" placeholder="移す理由（任意）" maxLength={500} value={moveReason} onChange={(e) => setMoveReason(e.target.value)} />
        <button type="button" disabled={busy || !targets.length} onClick={move}>移す</button></div>
      {moves.length > 0 && <table><thead><tr><th>移した先</th><th>日時</th><th>移した人</th><th>理由</th></tr></thead>
        <tbody>{moves.map((m) => <tr key={m.move_no}><td>{m.folder_name}</td><td>{jst(m.created_at)}</td><td>{m.author || '—'}</td><td>{m.reason || '—'}</td></tr>)}</tbody></table>}</section>}
    {(latest.purpose || latest.scene) && <div className="wt-box soft">{latest.purpose && <div><span className="wt-sub">何のため</span> {latest.purpose}</div>}{latest.scene && <div><span className="wt-sub">使う場面</span> {latest.scene}</div>}
      <div className="wt-sub">出どころ: <span className="wt-tag">{SOURCE_LABELS[latest.source.kind]}</span> {latest.source.origin ?? ''} {latest.source.note ?? ''}{latest.drive_ref ? ` ／ Google ドライブ: ${latest.drive_ref}` : ''}</div>
      {template.copied_from_template_id && <div className="wt-sub">複製元: ひな型 {template.copied_from_template_id} の第{template.copied_from_version_no}版</div>}</div>}
    {editing && <Editor draft={draft} setDraft={setDraft} isNew={false} busy={busy} onSubmit={submit} onCancel={() => setEditing(false)} />}
    {!editing && <FillPanel key={`${template.id}-${template.version_no}`} version={latest} />}
    <Files request={request} detail={detail} onChanged={load} setMessage={setMessage} />
    <section className="wt-box"><h3>版の履歴</h3><table><thead><tr><th>版</th><th>名前</th><th>日時</th><th>直した人</th><th>理由</th></tr></thead>
      <tbody>{versions.map((v) => <tr key={v.id}><td className="num">{v.version_no}</td><td>{v.name}{v.retired && <> <span className="wt-tag">やめた</span></>}</td><td>{jst(v.created_at)}</td><td>{v.author || '—'}</td><td>{v.reason || '最初の版'}</td></tr>)}</tbody></table></section>
  </>;
}

// ---- フォルダの中 ----
function FolderView({request, folder, onBack, onOpen, onChanged, setMessage}) {
  const [templates, setTemplates] = useState(null);
  const [revisions, setRevisions] = useState([]);
  const [renaming, setRenaming] = useState(false);
  const [form, setForm] = useState({name: '', description: '', retired: false, reason: ''});
  const [creating, setCreating] = useState(false);
  const [draft, setDraft] = useState(emptyDraft());
  const [busy, setBusy] = useState(false);
  const [withRetired, setWithRetired] = useState(false);
  const load = useCallback(async () => {
    try { const out = await request(`/work-templates/folders/${folder.id}/templates${withRetired ? '?retired=1' : ''}`); setTemplates(out.templates); setRevisions(out.revisions); } catch (error) { setMessage(error.message); }
  }, [request, folder.id, folder.rev_no, withRetired, setMessage]);
  useEffect(() => { load(); }, [load]);
  const create = async () => {
    setBusy(true); setMessage('');
    try { const out = await post(request, `/work-templates/folders/${folder.id}/templates`, tidy(draft)); setCreating(false); setDraft(emptyDraft()); onOpen(out.id); } catch (error) { setMessage(error.message); } finally { setBusy(false); }
  };
  const startRename = () => { setForm({name: folder.name, description: folder.description ?? '', retired: folder.retired, reason: ''}); setRenaming(true); };
  const saveRename = async (e) => {
    e.preventDefault(); setBusy(true); setMessage('');
    try { await post(request, `/work-templates/folders/${folder.id}/revisions`, {...form, expectedRev: folder.rev_no}); setRenaming(false); await onChanged(form.retired); } catch (error) { setMessage(error.message); } finally { setBusy(false); }
  };
  const copy = async (template, folderId) => {
    setBusy(true); setMessage('');
    try { const out = await post(request, `/work-templates/templates/${template.id}/copy`, {folderId}); onOpen(out.id); } catch (error) { setMessage(error.message); } finally { setBusy(false); }
  };
  return <>
    <div className="wt-bar"><div><div className="wt-crumb"><button type="button" onClick={onBack}>業務ひな型</button></div><h2>{folder.name}{folder.retired && <> <span className="wt-tag">やめた</span></>}</h2>{folder.description && <div className="wt-sub">{folder.description}</div>}</div>
      <div className="wt-row"><label><input type="checkbox" checked={withRetired} onChange={(e) => setWithRetired(e.target.checked)} /> やめたものも</label><button type="button" onClick={startRename} disabled={renaming}>名前などを直す</button><button className="on" type="button" onClick={() => setCreating(true)} disabled={creating || folder.retired}>ひな型を作る</button></div></div>
    {renaming && <form className="wt-box" onSubmit={saveRename}><h3>フォルダを直す</h3>
      <Field label="名前"><input required maxLength={80} value={form.name} onChange={(e) => setForm({...form, name: e.target.value})} /></Field>
      <Field label="説明（任意）"><input maxLength={300} value={form.description} onChange={(e) => setForm({...form, description: e.target.value})} /></Field>
      <Field label="直す理由（任意）"><input maxLength={500} value={form.reason} onChange={(e) => setForm({...form, reason: e.target.value})} /></Field>
      <label><input type="checkbox" checked={form.retired} onChange={(e) => setForm({...form, retired: e.target.checked})} /> このフォルダをやめる（一覧から外す。中のひな型は残る）</label>
      <div className="wt-row"><button className="on" type="submit" disabled={busy}>直す</button><button type="button" onClick={() => setRenaming(false)}>やめる</button></div></form>}
    {creating && <Editor draft={draft} setDraft={setDraft} isNew busy={busy} onSubmit={create} onCancel={() => setCreating(false)} />}
    {templates && <TemplateTable templates={templates} onOpen={onOpen} onCopy={copy} busy={busy} />}
    {revisions.length > 1 && <section className="wt-box"><h3>名前の履歴</h3><table><thead><tr><th>名前</th><th>説明</th><th>日時</th><th>直した人</th><th>理由</th></tr></thead>
      <tbody>{revisions.map((v) => <tr key={v.rev_no}><td>{v.name}{v.retired && <> <span className="wt-tag">やめた</span></>}</td><td>{v.description || '—'}</td><td>{jst(v.created_at)}</td><td>{v.author || '—'}</td><td>{v.rev_no === 0 ? '作った' : v.reason || '—'}</td></tr>)}</tbody></table></section>}
  </>;
}

function TemplateTable({templates, onOpen, onCopy, busy, showFolder}) {
  if (!templates.length) return <p className="wt-sub">ひな型はまだありません</p>;
  return <table><thead><tr><th>名前</th>{showFolder && <th>フォルダ</th>}<th>使う場面</th><th>版</th><th>原本</th><th>更新</th>{onCopy && <th />}</tr></thead>
    <tbody>{templates.map((t) => <tr key={t.id}><td><button type="button" onClick={() => onOpen(t.id)}>{t.name}</button>{t.retired && <> <span className="wt-tag">やめた</span></>}</td>{showFolder && <td>{t.folder_name}</td>}<td>{t.scene || '—'}</td>
      <td className="num">{t.version_no}</td><td className="num">{t.file_count}</td><td>{jst(t.updated_at)}</td>{onCopy && <td><button type="button" disabled={busy} onClick={() => onCopy(t, t.folder_id)}>複製</button></td>}</tr>)}</tbody></table>;
}

// ---- 一番上: フォルダの一覧 ----
export default function WorkTemplates({request}) {
  const [folders, setFolders] = useState(null);
  const [folderId, setFolderId] = useState(null);
  const [templateId, setTemplateId] = useState(null);
  const [message, setMessage] = useState('');
  const [query, setQuery] = useState('');
  const [results, setResults] = useState(null);
  const [adding, setAdding] = useState(false);
  const [showRetired, setShowRetired] = useState(false);
  const [form, setForm] = useState({name: '', description: ''});
  const loadFolders = useCallback(async () => {
    try { setFolders((await request(`/work-templates/folders${showRetired ? '?retired=1' : ''}`)).folders); } catch (error) { setMessage(error.message); }
  }, [request, showRetired]);
  useEffect(() => { loadFolders(); }, [loadFolders]);
  const folder = folders?.find((f) => f.id === folderId) ?? null;
  const openTemplate = async (id) => { setTemplateId(id); await loadFolders(); };
  const search = async (e) => {
    e.preventDefault(); setMessage('');
    if (!query.trim()) { setResults(null); return; }
    try { setResults((await request(`/work-templates/search?q=${encodeURIComponent(query.trim())}`)).templates); } catch (error) { setMessage(error.message); }
  };
  const addFolder = async (e) => {
    e.preventDefault(); setMessage('');
    try { const out = await post(request, '/work-templates/folders', form); setAdding(false); setForm({name: '', description: ''}); await loadFolders(); setFolderId(out.id); } catch (error) { setMessage(error.message); }
  };
  const back = () => { setTemplateId(null); loadFolders(); };
  let body;
  if (!folders) body = <p className="wt-sub">読み込み中</p>;
  else if (templateId) body = <TemplateView request={request} templateId={templateId} folders={folders} setMessage={setMessage} onBack={back} onOpen={openTemplate} />;
  else if (folder) body = <FolderView request={request} folder={folder} onChanged={async (retired) => { if (retired && !showRetired) setFolderId(null); await loadFolders(); }} setMessage={setMessage} onBack={() => setFolderId(null)} onOpen={openTemplate} />;
  else body = <>
    <div className="wt-bar"><h2>業務ひな型</h2><div className="wt-row"><label><input type="checkbox" checked={showRetired} onChange={(e) => setShowRetired(e.target.checked)} /> やめたフォルダも</label><button className="on" type="button" onClick={() => setAdding(true)} disabled={adding}>フォルダを作る</button></div></div>
    <form className="wt-row" onSubmit={search}><input className="wt-grow" aria-label="ひな型を探す" placeholder="名前・使う場面・ファイル名で探す" value={query} onChange={(e) => { setQuery(e.target.value); if (!e.target.value) setResults(null); }} /><button type="submit">探す</button></form>
    {adding && <form className="wt-box" onSubmit={addFolder}><h3>業務の種類のフォルダ</h3>
      <Field label="名前（例: 宿の手配）"><input required maxLength={80} value={form.name} onChange={(e) => setForm({...form, name: e.target.value})} /></Field>
      <Field label="説明（任意）"><input maxLength={300} value={form.description} onChange={(e) => setForm({...form, description: e.target.value})} /></Field>
      <div className="wt-row"><button className="on" type="submit">作る</button><button type="button" onClick={() => setAdding(false)}>やめる</button></div></form>}
    {results ? <TemplateTable templates={results} onOpen={(id) => { setFolderId(null); openTemplate(id); }} showFolder />
      : folders.length === 0 ? <p className="wt-sub">フォルダはまだありません</p>
        : <div className="wt-folders">{folders.map((f) => <button key={f.id} type="button" className="wt-folder" onClick={() => setFolderId(f.id)}><b>{f.name}{f.retired && <> <span className="wt-tag">やめた</span></>}</b>{f.description && <span className="wt-sub">{f.description}</span>}<span className="wt-count">{f.template_count} 件</span></button>)}</div>}
  </>;
  return <div className="wt">{message && <Notice tone="error" message={message} />}{body}</div>;
}
