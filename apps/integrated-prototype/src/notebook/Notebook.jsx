// 現場の連絡帳（共通の部品。調整役の X-23）。作品×部署のスペースで、型のガイドつきの連絡を出し、既読と了解を残す。
// 値は制作の表から入れられるものを入れる（「システムから」の欄）。見た目は docs/design/integrated-system-visual.md。
import React, {useEffect, useMemo, useState} from 'react';
import {NOTEBOOK_TEMPLATES, NOTEBOOK_DESIGNS, templateOf, fillFields, defaultTitle, unitLabel} from './notebook-model.mjs';
import './notebook.css';

function PostCard({post, onAck, onCorrect}) {
  return (
    <article className={`nb-post nb-${post.design}`}>
      <header><span className="nb-tag">{templateOf(post.template).label}</span><span className="nb-sub">{post.author || ''}　{String(post.created_at).slice(5, 16).replace('T', ' ')}</span></header>
      <h4>{post.title}{post.corrected ? <span className="nb-tag nb-weak"> 訂正あり</span> : null}{post.corrects_post_id ? <span className="nb-tag"> 訂正</span> : null}</h4>
      {post.fields.filter((f) => f.value).length > 0 && (
        <table><tbody>{post.fields.filter((f) => f.value).map((f) => <tr key={f.label}><th>{f.label}</th><td>{f.value}</td></tr>)}</tbody></table>
      )}
      {post.body && <p className="nb-body">{post.body}</p>}
      {post.attachments.length > 0 && <div className="nb-sub">添付 {post.attachments.map((id) => <a key={id} href={`/api/preprod/works/${post.work_id}/documents/${id}/content`} target="_blank" rel="noreferrer">原本 {id}</a>)}</div>}
      <footer>
        <span className="nb-sub">既読 {post.reads}{post.needs_ack ? `　了解 ${post.acks}` : ''}</span>
        <span>
          <button type="button" className="nb-ghost" onClick={() => onCorrect(post)}>訂正</button>
          {post.needs_ack ? <button type="button" className={post.ackedByMe ? 'on' : ''} disabled={post.ackedByMe} onClick={() => onAck(post)}>{post.ackedByMe ? '了解済' : '了解'}</button> : null}
        </span>
      </footer>
    </article>
  );
}

export default function Notebook({workId, request, production, documents = []}) {
  const [spaces, setSpaces] = useState(null);
  const [spaceId, setSpaceId] = useState(null);
  const [posts, setPosts] = useState([]);
  const [msg, setMsg] = useState('');
  const [reloadNo, setReloadNo] = useState(0);
  const [draft, setDraft] = useState(null);

  useEffect(() => {
    let alive = true;
    request(`/notebook/spaces?workId=${workId}`).then((r) => { if (!alive) return; setSpaces(r.spaces); setSpaceId((id) => id || r.spaces[0]?.id || null); }).catch((e) => alive && setMsg(e.message || '読み込めませんでした'));
    return () => { alive = false; };
  }, [workId, request, reloadNo]);

  useEffect(() => {
    if (!spaceId) return;
    let alive = true;
    request(`/notebook/spaces/${spaceId}/posts`).then(async (r) => {
      if (!alive) return;
      setPosts(r.posts);
      const unread = r.posts.filter((p) => !p.readByMe);
      for (const p of unread) await request(`/notebook/posts/${p.id}/read`, {method: 'POST', body: '{}'}).catch(() => null);
    }).catch((e) => alive && setMsg(e.message || '読み込めませんでした'));
    return () => { alive = false; };
  }, [spaceId, request, reloadNo]);

  const days = production?.days || [];
  const locations = production?.locations || [];
  const startDraft = (template, base = {}) => {
    const fields = fillFields(template, production, base);
    setDraft({template, fields, title: defaultTitle(template, fields), body: '', design: template === 'daily' || template === 'call' ? 'table' : 'simple', attachments: [], ...base});
  };
  const space = useMemo(() => (spaces || []).find((s) => s.id === spaceId), [spaces, spaceId]);

  async function send() {
    setMsg('');
    try {
      await request(`/notebook/spaces/${spaceId}/posts`, {method: 'POST', body: JSON.stringify({template: draft.template, title: draft.title, fields: draft.fields, body: draft.body || null, design: draft.design, attachments: draft.attachments, correctsPostId: draft.correctsPostId || null})});
      setDraft(null); setReloadNo((n) => n + 1);
    } catch (e) { setMsg(e.message || '出せませんでした'); }
  }
  const ack = async (p) => { await request(`/notebook/posts/${p.id}/ack`, {method: 'POST', body: '{}'}); setReloadNo((n) => n + 1); };
  const correct = (p) => setDraft({template: p.template, fields: p.fields, title: `訂正: ${p.title.replace(/^訂正: /, '')}`, body: p.body || '', design: p.design, attachments: p.attachments, correctsPostId: p.id});
  const t = draft ? templateOf(draft.template) : null;

  return (
    <div className="nb">
      <nav className="nb-spaces">
        {(spaces || []).map((s) => <button type="button" key={s.id} className={s.id === spaceId ? 'on' : ''} onClick={() => { setSpaceId(s.id); setDraft(null); }}><span># {s.name}</span>{s.unread ? <span className="nb-unread">{s.unread}</span> : null}</button>)}
      </nav>
      <div className="nb-main">
        <div className="nb-bar">
          <b># {space?.name || ''}</b>
          {!draft && <span className="nb-new">{NOTEBOOK_TEMPLATES.map((x) => <button type="button" key={x.id} onClick={() => startDraft(x.id)}>＋ {x.label}</button>)}</span>}
        </div>
        {draft && (
          <div className="nb-compose">
            <div className="nb-row">
              <span className="nb-tag">{t.label}</span>
              {(draft.template === 'daily' || draft.template === 'call') && <select value={draft.dayId || ''} onChange={(e) => startDraft(draft.template, {dayId: Number(e.target.value)})}><option value="">撮影日</option>{days.map((d) => <option key={d.id} value={d.id}>{d.shoot_date} {unitLabel(d.unit)} {d.label}</option>)}</select>}
              {draft.template === 'location' && <select value={draft.locationKey || ''} onChange={(e) => startDraft('location', {locationKey: e.target.value})}><option value="">ロケ地</option>{locations.map((l) => <option key={l.key} value={l.key}>{l.name}</option>)}</select>}
              <select value={draft.design} onChange={(e) => setDraft({...draft, design: e.target.value})}>{Object.entries(NOTEBOOK_DESIGNS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select>
            </div>
            <label className="nb-field"><span>題</span><input value={draft.title} onChange={(e) => setDraft({...draft, title: e.target.value})} /></label>
            {draft.fields.map((f, k) => (
              <label key={f.label} className={`nb-field ${f.system ? 'nb-sys' : ''}`}><span>{f.label}</span>
                <input value={f.value} onChange={(e) => setDraft({...draft, fields: draft.fields.map((x, j) => (j === k ? {...x, value: e.target.value, system: false} : x))})} /></label>
            ))}
            <label className="nb-field"><span>本文</span><textarea rows={3} value={draft.body} onChange={(e) => setDraft({...draft, body: e.target.value})} /></label>
            {t.phrases.length > 0 && <div className="nb-row">{t.phrases.map((p) => <button type="button" key={p} className="nb-ghost" onClick={() => setDraft({...draft, body: `${draft.body ? `${draft.body}\n` : ''}${p}`})}>＋ {p}</button>)}</div>}
            {documents.length > 0 && <label className="nb-field"><span>添付</span>
              <select multiple value={draft.attachments.map(String)} onChange={(e) => setDraft({...draft, attachments: [...e.target.selectedOptions].map((o) => Number(o.value))})}>{documents.map((d) => <option key={d.document_id} value={d.document_id}>{d.file_name}</option>)}</select></label>}
            <div className="nb-preview">
              <PostCard post={{...draft, id: 0, work_id: workId, created_at: '', author: '', reads: 0, acks: 0, needs_ack: t.needsAck ? 1 : 0, corrects_post_id: draft.correctsPostId || null}} onAck={() => {}} onCorrect={() => {}} /></div>
            <div className="nb-row"><button type="button" className="on" onClick={send}>出す</button><button type="button" onClick={() => window.print()}>印刷</button><button type="button" onClick={() => setDraft(null)}>やめる</button></div>
          </div>
        )}
        {msg && <p className="nb-stop">{msg}</p>}
        {posts.map((p) => <PostCard key={p.id} post={p} onAck={ack} onCorrect={correct} />)}
      </div>
    </div>
  );
}
