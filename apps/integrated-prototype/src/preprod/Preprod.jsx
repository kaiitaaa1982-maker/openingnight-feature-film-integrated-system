// プリプロダクション（フォルダ原案 F03）の業務画面。要対応・子フォルダの帯・数字と、オールスタッフ／美術打ち合わせの資料。
// 見た目は docs/design/integrated-system-visual.md（黒・白・灰と赤1色、角丸0・影なし、状態は文字の札）。
import React, {useEffect, useMemo, useState} from 'react';
import {meetingDocument, pagesText, ARRANGEMENT_KINDS, ARRANGEMENT_STATES, ART_KINDS, ART_STATES} from './preprod-model.mjs';
import Vault from './Vault.jsx';
import Notebook from '../notebook/Notebook.jsx';
import './preprod.css';

const todayJst = () => new Date(Date.now() + 9 * 3600000).toISOString().slice(0, 10);
const md = (d) => (d ? `${Number(d.slice(5, 7))}/${Number(d.slice(8, 10))}` : '—');
const STATE_TAG = {done: '', in_progress: '', needs_review: 'red', not_started: 'weak'};

function Chapter({no, title, children, art, version}) {
  if (version === 'art' && !art) return null;
  return (
    <section className="pp-page">
      <div className="pp-no">{no}</div>
      <h2>{title}</h2>
      {children}
    </section>
  );
}

// 1行の入力欄。fields は [名前, ラベル, 種類（text・date・number・select）, 選択肢]。保存は新しい版を足す
function RowForm({fields, initial, onSave, onCancel}) {
  const [v, setV] = useState(initial || {});
  const [err, setErr] = useState('');
  const set = (k) => (e) => setV({...v, [k]: e.target.value});
  return (
    <form className="pp-form" onSubmit={async (e) => { e.preventDefault(); setErr(''); try { await onSave(v); } catch (x) { setErr(x.message || '保存できませんでした'); } }}>
      {fields.map(([k, label, type, options]) => (
        <label key={k}><span>{label}</span>
          {type === 'select'
            ? <select value={v[k] ?? ''} onChange={set(k)}>{Object.entries(options).map(([o, l]) => <option key={o} value={o}>{l}</option>)}</select>
            : <input type={type || 'text'} value={v[k] ?? ''} onChange={set(k)} />}
        </label>
      ))}
      <div className="pp-form-act"><button type="submit" className="on">保存</button><button type="button" onClick={onCancel}>やめる</button>{err && <span className="pp-stop">{err}</span>}</div>
    </form>
  );
}

const ARR_FIELDS = [['kind', '種類', 'select', ARRANGEMENT_KINDS], ['item', '品目'], ['quantity', '数量', 'number'], ['unit', '単位'], ['capacity', '定員', 'number'], ['startsOn', '開始', 'date'], ['endsOn', '終了', 'date'], ['deadlineOn', '締切', 'date'], ['state', '状態', 'select', ARRANGEMENT_STATES], ['note', 'メモ']];
const ART_FIELDS = (sceneOptions) => [['sceneId', 'シーン', 'select', sceneOptions], ['kind', '種類', 'select', ART_KINDS], ['content', '中身'], ['owner', '担当'], ['deliveryOn', '搬入', 'date'], ['state', '状態', 'select', ART_STATES], ['note', 'メモ']];
const PLAN_FIELDS = [['methods', '手法'], ['equipment', '要る機材'], ['note', 'メモ']];
const arrInitial = (a) => (a ? {key: a.arrangement_key, kind: a.kind, item: a.item, quantity: a.quantity ?? '', unit: a.unit ?? '', capacity: a.capacity ?? '', startsOn: a.starts_on ?? '', endsOn: a.ends_on ?? '', deadlineOn: a.deadline_on ?? '', state: a.state, note: a.note ?? ''} : {kind: 'camera', state: 'hold'});
const artInitial = (a) => (a ? {key: a.item_key, sceneId: a.scene_id ?? '', kind: a.kind, content: a.content, owner: a.owner_label ?? '', deliveryOn: a.delivery_on ?? '', state: a.state, note: a.note ?? ''} : {kind: 'dressing', state: 'open', sceneId: ''});

// 連絡帳の添付に保管庫の原本を出す
function NotebookWithDocs({workId, request, production}) {
  const [docs, setDocs] = useState([]);
  useEffect(() => { request(`/preprod/works/${workId}/documents`).then((r) => setDocs(r.documents || [])).catch(() => setDocs([])); }, [workId, request]);
  return <Notebook workId={workId} request={request} production={production} documents={docs} />;
}

export default function Preprod({data, request, onNavigate}) {
  const workId = data.selectedWorkId;
  const title = data.selectedWork?.title || '';
  const [view, setView] = useState('status');
  const [version, setVersion] = useState('all');
  const [state, setState] = useState({loading: true});
  const [edit, setEdit] = useState(null); // {kind: 'arr'|'art'|'plan', row}
  const [reloadNo, setReloadNo] = useState(0);

  useEffect(() => {
    if (!workId) return;
    let alive = true;
    setState({loading: true});
    Promise.all([
      request(`/production?workId=${workId}`),
      request(`/workflow/scripts?workId=${workId}`).catch(() => ({rows: []})),
      request(`/field?workId=${workId}`).catch(() => ({tasks: []})),
      request(`/preprod/works/${workId}/plans`).catch(() => null),
    ]).then(([production, scripts, field, plans]) => {
      if (alive) setState({production, scripts: scripts.rows || [], field, plans});
    }).catch((error) => alive && setState({error: error.message || '読み込めませんでした'}));
    return () => { alive = false; };
  }, [workId, request, reloadNo]);

  const today = todayJst();
  const doc = useMemo(() => (state.production ? meetingDocument({production: state.production, scripts: state.scripts, field: state.field, plans: state.plans, today}) : null), [state, today]);

  if (!workId) return <div className="pp"><p>左上で作品を選ぶ</p></div>;
  if (state.error) return <div className="pp"><p className="pp-stop">{state.error}</p></div>;
  if (!doc) return <div className="pp"><p className="pp-sub">読み込み中</p></div>;
  const s = doc.summary;
  const go = (t) => (t.view ? setView(t.view) : onNavigate?.(t.page, t.tab ? {tab: t.tab} : {}));
  const canEdit = Boolean(state.plans);
  const save = (path) => async (v) => { await request(`/preprod/works/${workId}/${path}`, {method: 'POST', body: JSON.stringify(v)}); setEdit(null); setReloadNo((n) => n + 1); };
  const sceneOptions = Object.fromEntries([['', '—'], ...doc.scenes.map((sc) => [String(sc.id), `S#${sc.no}`])]);
  const partnerName = new Map((state.plans?.partners || []).map((p) => [p.id, p.name]));

  return (
    <div className="pp">
      <div className="pp-head">
        <div className="pp-mark">Pre-production</div>
        <div className="pp-tabs">
          <button type="button" className={view === 'status' ? 'on' : ''} onClick={() => setView('status')}>状況</button>
          <button type="button" className={view === 'doc' ? 'on' : ''} onClick={() => setView('doc')}>資料</button>
          <button type="button" className={view === 'vault' ? 'on' : ''} onClick={() => setView('vault')}>保管庫</button>
          <button type="button" className={view === 'notebook' ? 'on' : ''} onClick={() => setView('notebook')}>連絡帳</button>
        </div>
      </div>

      {view === 'status' && (
        <>
          {s.todos.length > 0 ? (
            <div className="pp-alert">
              <span className="pp-alert-h">! 要対応 {s.todos.length}</span>
              {s.todos.map((t) => (
                <div className="pp-row" key={t.key}>
                  <span>{t.text} <b className="pp-num">{t.count}</b>{t.detail ? <span className="pp-sub">　{t.detail}</span> : null}</span>
                  <button type="button" className="pp-ghost" onClick={() => go(t)}>直す</button>
                </div>
              ))}
            </div>
          ) : null}

          <div className="pp-band">
            {s.folders.map((f) => (
              <button type="button" key={f.id} className="pp-cell" onClick={() => f.page && go(f)} disabled={!f.page}>
                <span className="pp-cell-l">{f.label}</span>
                <span className={`pp-tag ${STATE_TAG[f.state]}`}>{f.text}</span>
              </button>
            ))}
          </div>

          <div className="pp-meta">
            <div>撮影日<b>{s.numbers.days}</b></div>
            <div>シーン<b>{s.numbers.scenes}</b></div>
            <div>頁<b>{pagesText(s.numbers.pages)}</b></div>
            <div>撮影まで<b>{s.numbers.untilShoot == null ? '—' : `${s.numbers.untilShoot}日`}</b></div>
          </div>
        </>
      )}

      {view === 'vault' && <Vault workId={workId} request={request} />}
      {view === 'notebook' && <NotebookWithDocs workId={workId} request={request} production={state.production} />}

      {view === 'doc' && (
        <div className="pp-doc">
          <div className="pp-docbar">
            <button type="button" className={version === 'all' ? 'on' : ''} onClick={() => setVersion('all')}>オールスタッフ</button>
            <button type="button" className={version === 'art' ? 'on' : ''} onClick={() => setVersion('art')}>美術打ち合わせ</button>
            <button type="button" onClick={() => window.print()}>印刷</button>
          </div>

          <Chapter no="00" title={`${title} ${version === 'all' ? 'オールスタッフ' : '美術打ち合わせ'}`} art version={version}>
            <div className="pp-meta">
              <div>撮影期間<b>{md(doc.cover.firstDay)}–{md(doc.cover.lastDay)}</b></div>
              <div>撮影日<b>{doc.cover.days - doc.cover.reserveDays}{doc.cover.reserveDays ? ` + 予備 ${doc.cover.reserveDays}` : ''}</b></div>
              <div>シーン<b>{doc.cover.scenes}</b></div>
              <div>頁<b>{pagesText(doc.cover.pages)}</b></div>
            </div>
          </Chapter>

          <Chapter no="01" title="決めること" art version={version}>
            {doc.decisions.length ? (
              <div className="pp-alert"><span className="pp-alert-h">! {doc.decisions.length}</span>
                <table><tbody>{doc.decisions.map((t) => <tr key={t.key}><td>{t.text}</td><td className="pp-num">{t.count}</td><td className="pp-sub">{t.detail || ''}</td></tr>)}</tbody></table>
              </div>
            ) : null}
            {doc.tasks.length > 0 && (
              <table><thead><tr><th>準備タスク</th><th>担当</th><th>期限</th><th>状態</th></tr></thead>
                <tbody>{doc.tasks.map((t, i) => <tr key={i}><td>{t.title}</td><td>{t.owner}</td><td>{t.due}</td><td><span className={`pp-tag ${t.status === 'blocked' ? 'red' : ''}`}>{t.status === 'blocked' ? '止' : '未'}</span></td></tr>)}</tbody></table>
            )}
          </Chapter>

          <Chapter no="02" title="日程" art version={version}>
            <table><thead><tr><th>日</th><th>班</th><th>名前</th><th>シーン</th><th>ロケ地</th></tr></thead>
              <tbody>{doc.schedule.map((d) => <tr key={d.id}><td>{md(d.date)}</td><td>{d.unit}</td><td>{d.reserve ? <span className="pp-tag">予備</span> : d.label}</td><td>{d.scenes.length ? d.scenes.map((n) => `S#${n}`).join('・') : '—'}</td><td>{d.locations.join('・')}</td></tr>)}</tbody></table>
          </Chapter>

          <Chapter no="03" title="香盤" version={version}>
            <table><thead><tr><th>日</th><th>シーン</th><th>昼夜</th><th className="pp-num">頁</th><th className="pp-num">予定分</th></tr></thead>
              <tbody>{doc.schedule.filter((d) => d.scenes.length).map((d) => <tr key={d.id}><td>{md(d.date)} {d.unit}</td><td>{d.scenes.map((n) => `S#${n}`).join('・')}</td><td>{d.dayNight}</td><td className="pp-num">{pagesText(d.pages)}</td><td className="pp-num">{d.minutes || '—'}</td></tr>)}</tbody></table>
          </Chapter>

          <Chapter no="04" title="シーン" art version={version}>
            <table><thead><tr><th>S#</th><th>場所</th><th>昼夜</th><th>出演</th><th>衣装</th><th className="pp-num">頁</th><th>撮影日</th><th>手法</th><th>要る機材</th><th>メモ</th>{canEdit && <th></th>}</tr></thead>
              <tbody>{doc.scenes.map((sc) => <tr key={sc.no}><td>{sc.no}</td><td>{sc.location}</td><td>{sc.dayNight}</td><td>{sc.cast.join('・')}</td><td>{sc.looks.join('・')}</td><td className="pp-num">{pagesText(sc.pages)}</td><td>{sc.days.map(md).join('・') || <span className="pp-tag red">未割当</span>}</td><td>{sc.methods}</td><td>{sc.equipment}</td><td>{sc.note}</td>{canEdit && <td><button type="button" className="pp-ghost" onClick={() => setEdit({kind: 'plan', row: sc})}>直す</button></td>}</tr>)}</tbody></table>
            {edit?.kind === 'plan' && <div><b>S#{edit.row.no} の撮影の方針</b><RowForm fields={PLAN_FIELDS} initial={{methods: edit.row.methods, equipment: edit.row.equipment}} onSave={(v) => save('shoot-plans')({...v, sceneId: edit.row.id})} onCancel={() => setEdit(null)} /></div>}
          </Chapter>

          <Chapter no="05" title="美術" art version={version}>
            {canEdit && <>
              <table><thead><tr><th>S#</th><th>種類</th><th>中身</th><th>担当</th><th>搬入</th><th>状態</th><th></th></tr></thead>
                <tbody>{doc.art.map((a) => <tr key={a.item_key} className={a.state === 'cancelled' ? 'pp-off' : ''}><td>{a.scene_no}</td><td>{ART_KINDS[a.kind]}</td><td>{a.content}</td><td>{a.owner_label}</td><td>{md(a.delivery_on)}</td><td><span className={`pp-tag ${a.state === 'open' ? 'red' : a.state === 'cancelled' ? 'weak' : ''}`}>{ART_STATES[a.state]}</span></td><td><button type="button" className="pp-ghost" onClick={() => setEdit({kind: 'art', row: a})}>直す</button></td></tr>)}</tbody></table>
              {edit?.kind === 'art' ? <RowForm fields={ART_FIELDS(sceneOptions)} initial={artInitial(edit.row)} onSave={save('art-items')} onCancel={() => setEdit(null)} /> : <button type="button" onClick={() => setEdit({kind: 'art', row: null})}>＋ 美術</button>}
            </>}
          </Chapter>

          <Chapter no="06" title="ロケ地" art version={version}>
            <table><thead><tr><th>ロケ地</th><th>撮影日</th><th>住所</th><th>控室</th><th>駐車場</th><th>設備</th></tr></thead>
              <tbody>{doc.locations.map((l) => <tr key={l.name}><td>{l.name}</td><td>{l.days.map(md).join('・')}</td><td>{l.address || <span className="pp-tag red">未入力</span>}</td><td>{l.greenRoom}</td><td>{l.parking}</td><td>{l.facilities}</td></tr>)}</tbody></table>
          </Chapter>

          <Chapter no="07" title="キャスト" version={version}>
            <table><thead><tr><th>役</th><th>俳優</th><th className="pp-num">出番の日</th><th>ルック</th></tr></thead>
              <tbody>{doc.cast.map((c) => <tr key={c.role}><td>{c.role}</td><td>{c.actor || <span className="pp-tag red">未入力</span>}</td><td className="pp-num">{c.days}</td><td>{c.looks.join('・')}</td></tr>)}</tbody></table>
          </Chapter>

          <Chapter no="08" title="手配" version={version}>
            {canEdit && <>
              <table><thead><tr><th>種類</th><th>品目</th><th className="pp-num">数量</th><th>期間</th><th>締切</th><th>取引先</th><th>状態</th><th></th></tr></thead>
                <tbody>{doc.arrangements.map((a) => <tr key={a.arrangement_key} className={a.state === 'cancelled' ? 'pp-off' : ''}><td>{ARRANGEMENT_KINDS[a.kind]}</td><td>{a.item}{a.capacity ? `（定員 ${a.capacity}）` : ''}</td><td className="pp-num">{a.quantity ?? ''}{a.unit || ''}</td><td>{md(a.starts_on)}–{md(a.ends_on)}</td><td>{md(a.deadline_on)}</td><td>{partnerName.get(a.partner_id) || ''}</td><td><span className={`pp-tag ${a.state === 'hold' && a.deadline_on && a.deadline_on < today ? 'red' : a.state === 'cancelled' ? 'weak' : ''}`}>{ARRANGEMENT_STATES[a.state]}</span></td><td><button type="button" className="pp-ghost" onClick={() => setEdit({kind: 'arr', row: a})}>直す</button></td></tr>)}</tbody></table>
              {edit?.kind === 'arr' ? <RowForm fields={ARR_FIELDS} initial={arrInitial(edit.row)} onSave={save('arrangements')} onCancel={() => setEdit(null)} /> : <button type="button" onClick={() => setEdit({kind: 'arr', row: null})}>＋ 手配</button>}
            </>}
          </Chapter>

          <Chapter no="09" title="リスク" version={version}>
            <p>予備日: {doc.schedule.filter((d) => d.reserve).map((d) => md(d.date)).join('・') || <span className="pp-tag red">無い</span>}</p>
          </Chapter>
        </div>
      )}
    </div>
  );
}
