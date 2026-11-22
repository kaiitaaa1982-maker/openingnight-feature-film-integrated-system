// 撮影の許可申請（道路・公園・施設）を全案件で1行1件に並べる画面（ページ ID `許可申請`、`?p=permits`。移行 0060）。
// 見た目は docs/design/integrated-system-visual.md（黒・白・灰と赤1色、角丸0・影なし、状態は文字の札）。赤は差戻と、申請の最終日を過ぎた準備だけ。
import React, {useEffect, useMemo, useState} from 'react';
import {PERMIT_KINDS, PERMIT_STATES, PERMIT_DOCUMENT_ROLES, filterRows, pickupFrom} from './permit-model.mjs';
import './permits.css';

const md = (d) => (d ? `${Number(d.slice(5, 7))}/${Number(d.slice(8, 10))}` : '—');
const days = (a, b) => (a === b ? md(a) : `${md(a)}〜${md(b)}`);
const num = (n) => (n == null ? '—' : new Intl.NumberFormat('ja-JP').format(n));
const blank = {kind: 'road', officeId: '', place: '', startsOn: '', endsOn: '', appliedOn: '', pickupOn: '', receivedOn: '', state: 'draft', feeYen: '', note: ''};
const toForm = (r) => ({kind: r.kind, officeId: String(r.officeId), place: r.place, startsOn: r.startsOn, endsOn: r.endsOn, appliedOn: r.appliedOn || '',
  pickupOn: r.pickupOn || '', receivedOn: r.receivedOn || '', state: r.state, feeYen: r.feeYen == null ? '' : String(r.feeYen), note: r.note || ''});
const toBody = (v) => ({...v, officeId: Number(v.officeId), feeYen: v.feeYen === '' ? null : Number(v.feeYen), endsOn: v.endsOn || v.startsOn});

function Chips({value, options, onChange, label}) {
  return (
    <div className="pm-chips" role="group" aria-label={label}>
      <button type="button" className={value == null ? 'on' : ''} onClick={() => onChange(null)}>全部</button>
      {options.map(([k, l]) => <button type="button" key={k} className={value === k ? 'on' : ''} onClick={() => onChange(k)}>{l}</button>)}
    </div>
  );
}

function PermitForm({initial, offices, works, isNew, onSave, onCancel}) {
  const [v, setV] = useState(initial);
  const [err, setErr] = useState('');
  const set = (k) => (e) => setV({...v, [k]: e.target.value});
  const office = offices.find((o) => String(o.id) === String(v.officeId));
  const suggested = office ? pickupFrom({appliedOn: v.appliedOn, leadBusinessDays: office.leadBusinessDays}) : null;
  return (
    <form className="pm-form" aria-label="申請" onSubmit={async (e) => { e.preventDefault(); setErr(''); try { await onSave(v); } catch (x) { setErr(x.message || '保存できませんでした'); } }}>
      {isNew && <label><span>作品</span><select value={v.workId ?? ''} onChange={set('workId')}><option value="">—</option>{works.map((w) => <option key={w.id} value={w.id}>{w.title}</option>)}</select></label>}
      {isNew && <label><span>種類</span><select value={v.kind} onChange={set('kind')}>{Object.entries(PERMIT_KINDS).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></label>}
      <label><span>提出先</span><select value={v.officeId} onChange={set('officeId')}><option value="">—</option>{offices.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}</select></label>
      <label className="pm-wide"><span>場所</span><input value={v.place} onChange={set('place')} /></label>
      <label><span>使う日</span><input type="date" value={v.startsOn} onChange={set('startsOn')} /></label>
      <label><span>終わり</span><input type="date" value={v.endsOn} onChange={set('endsOn')} /></label>
      <label><span>申請日</span><input type="date" value={v.appliedOn} onChange={set('appliedOn')} /></label>
      <label><span>受け取り予定</span><input type="date" value={v.pickupOn} placeholder={suggested || ''} onChange={set('pickupOn')} />
        {suggested && !v.pickupOn && <button type="button" className="pm-link" onClick={() => setV({...v, pickupOn: suggested})}>{md(suggested)}</button>}</label>
      <label><span>受け取り</span><input type="date" value={v.receivedOn} onChange={set('receivedOn')} /></label>
      <label><span>状態</span><select value={v.state} onChange={set('state')}>{Object.entries(PERMIT_STATES).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></label>
      <label><span>手数料</span><input inputMode="numeric" value={v.feeYen} onChange={set('feeYen')} /></label>
      <label className="pm-wide"><span>メモ</span><input value={v.note} onChange={set('note')} /></label>
      <div className="pm-act"><button type="submit" className="on">保存</button><button type="button" onClick={onCancel}>やめる</button>{err && <span className="pm-stop">{err}</span>}</div>
    </form>
  );
}

function OfficeForm({onSave, onCancel}) {
  const [v, setV] = useState({name: '', leadBusinessDays: '', maxSpanDays: ''});
  const [err, setErr] = useState('');
  const set = (k) => (e) => setV({...v, [k]: e.target.value});
  return (
    <form className="pm-form" aria-label="提出先" onSubmit={async (e) => { e.preventDefault(); setErr(''); try { await onSave(v); } catch (x) { setErr(x.message || '保存できませんでした'); } }}>
      <label className="pm-wide"><span>提出先</span><input value={v.name} onChange={set('name')} /></label>
      <label><span>中N日</span><input inputMode="numeric" value={v.leadBusinessDays} onChange={set('leadBusinessDays')} /></label>
      <label><span>上限の日数</span><input inputMode="numeric" value={v.maxSpanDays} onChange={set('maxSpanDays')} /></label>
      <div className="pm-act"><button type="submit" className="on">足す</button><button type="button" onClick={onCancel}>やめる</button>{err && <span className="pm-stop">{err}</span>}</div>
    </form>
  );
}

function Detail({row, offices, request, onChanged}) {
  const [detail, setDetail] = useState(null);
  const [vault, setVault] = useState([]);
  const [link, setLink] = useState({documentId: '', role: 'application'});
  const [msg, setMsg] = useState('');
  const [reloadNo, setReloadNo] = useState(0);
  useEffect(() => {
    let alive = true;
    request(`/permits/${row.id}`).then((r) => alive && setDetail(r)).catch((e) => alive && setMsg(e.message || '読み込めませんでした'));
    request(`/preprod/works/${row.workId}/documents`).then((r) => alive && setVault(r.documents || [])).catch(() => alive && setVault([]));
    return () => { alive = false; };
  }, [row.id, row.workId, request, reloadNo]);
  if (!detail) return <p className="pm-sub">{msg || '読み込み中'}</p>;
  const linked = new Set(detail.documents.map((d) => d.document_id));
  // 作品のプリプロの保管庫に置いた原本は、名前を押すと開く（保管庫に無い原本は名前だけ。原本の置き場から開く）
  const placed = new Set(vault.map((d) => d.document_id));
  const choices = vault.filter((d) => !linked.has(d.document_id));
  async function save(v) {
    await request(`/permits/${row.id}/versions`, {method: 'POST', body: JSON.stringify({...toBody(v), baseVersionNo: row.versionNo})});
    onChanged();
  }
  async function attach() {
    setMsg('');
    try { await request(`/permits/${row.id}/documents`, {method: 'POST', body: JSON.stringify({documentId: Number(link.documentId), role: link.role})}); setLink({...link, documentId: ''}); setReloadNo((n) => n + 1); onChanged(); }
    catch (e) { setMsg(e.message || '結び付けられませんでした'); }
  }
  return (
    <div className="pm-detail">
      {detail.canWrite ? <PermitForm initial={toForm(row)} offices={offices} works={[]} onSave={save} onCancel={onChanged} /> : null}
      <table aria-label="原本"><thead><tr><th>書類</th><th>ファイル</th><th>受領</th></tr></thead>
        <tbody>{detail.documents.map((d) => <tr key={d.id}><td><span className="pm-tag">{PERMIT_DOCUMENT_ROLES[d.role]}</span></td>
          <td>{placed.has(d.document_id) ? <a href={`/api/preprod/works/${row.workId}/documents/${d.document_id}/content`} target="_blank" rel="noopener">{d.file_name}</a> : d.file_name}</td><td>{md(d.received_on)}</td></tr>)}
          {!detail.documents.length && <tr><td colSpan={3} className="pm-sub">—</td></tr>}</tbody></table>
      {detail.canWrite && (
        <div className="pm-act">
          <select aria-label="結び付ける原本" value={link.documentId} onChange={(e) => setLink({...link, documentId: e.target.value})}><option value="">—</option>{choices.map((d) => <option key={d.document_id} value={d.document_id}>{d.file_name}</option>)}</select>
          <select aria-label="書類の種類" value={link.role} onChange={(e) => setLink({...link, role: e.target.value})}>{Object.entries(PERMIT_DOCUMENT_ROLES).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select>
          <button type="button" disabled={!link.documentId} onClick={attach}>結び付け</button>
          {msg && <span className="pm-stop">{msg}</span>}
        </div>
      )}
    </div>
  );
}

export default function Permits({request}) {
  const [data, setData] = useState(null);
  const [err, setErr] = useState('');
  const [workId, setWorkId] = useState(null);
  const [kind, setKind] = useState(null);
  const [open, setOpen] = useState(null);
  const [adding, setAdding] = useState('');
  const [reloadNo, setReloadNo] = useState(0);
  useEffect(() => {
    let alive = true;
    request('/permits').then((r) => alive && setData(r)).catch((e) => alive && setErr(e.message || '読み込めませんでした'));
    return () => { alive = false; };
  }, [request, reloadNo]);
  const rows = useMemo(() => filterRows(data?.applications || [], {workId, kind}), [data, workId, kind]);
  const reload = () => { setOpen(null); setAdding(''); setReloadNo((n) => n + 1); };
  if (!data) return <div className="pm"><p className="pm-sub">{err || '読み込み中'}</p></div>;
  const alerts = (data.applications || []).filter((r) => r.alert).length;
  const writable = data.works.filter((w) => w.canWrite);
  async function create(v) {
    await request('/permits', {method: 'POST', body: JSON.stringify({...toBody(v), workId: Number(v.workId)})});
    reload();
  }
  async function addOffice(v) {
    await request('/permit-offices', {method: 'POST', body: JSON.stringify({name: v.name, leadBusinessDays: v.leadBusinessDays === '' ? null : Number(v.leadBusinessDays), maxSpanDays: v.maxSpanDays === '' ? null : Number(v.maxSpanDays)})});
    reload();
  }
  return (
    <div className="pm">
      <div className="pm-bar">
        <Chips label="作品" value={workId} options={data.works.map((w) => [w.id, w.title])} onChange={setWorkId} />
        <Chips label="種類" value={kind} options={Object.entries(PERMIT_KINDS)} onChange={setKind} />
        <span className="pm-fill" />
        {alerts > 0 && <span className="pm-alert">! 要確認 {alerts}</span>}
        {writable.length > 0 && <button type="button" onClick={() => setAdding(adding === 'permit' ? '' : 'permit')}>＋ 申請</button>}
        <button type="button" onClick={() => setAdding(adding === 'office' ? '' : 'office')}>＋ 提出先</button>
      </div>
      {adding === 'permit' && <PermitForm isNew initial={{...blank, workId: writable[0]?.id ?? ''}} offices={data.offices} works={writable} onSave={create} onCancel={() => setAdding('')} />}
      {adding === 'office' && <OfficeForm onSave={addOffice} onCancel={() => setAdding('')} />}
      <div className="pm-scroll">
        <table aria-label="許可申請">
          <thead><tr><th>作品</th><th>種類</th><th>提出先</th><th>場所</th><th>使う日</th><th>申請日</th><th>受け取り予定</th><th>状態</th><th className="pm-num">手数料</th><th className="pm-num">原本</th><th>申請の最終日</th></tr></thead>
          <tbody>
            {rows.map((r) => (
              <React.Fragment key={r.id}>
                <tr className={r.alert ? 'pm-hot' : 'pm-calm'} onClick={() => setOpen(open === r.id ? null : r.id)} aria-expanded={open === r.id}>
                  <td>{r.workTitle}</td><td>{PERMIT_KINDS[r.kind]}</td><td>{r.officeName}</td><td>{r.place}</td>
                  <td>{days(r.startsOn, r.endsOn)}{r.spanOver && <span className="pm-tag red"> 上限超</span>}</td>
                  <td>{md(r.appliedOn)}</td><td>{md(r.receivedOn || r.pickupOn)}</td>
                  <td><span className={`pm-tag${r.alert === 'returned' ? ' red' : ''}`}>{PERMIT_STATES[r.state]}</span></td>
                  <td className="pm-num">{num(r.feeYen)}</td><td className="pm-num">{r.documentCount}</td>
                  <td className={r.alert === 'late' ? 'pm-late' : ''}>{r.state === 'draft' ? md(r.applyBy) : '—'}</td>
                </tr>
                {open === r.id && <tr className="pm-open"><td colSpan={11}><Detail row={r} offices={data.offices} request={request} onChanged={reload} /></td></tr>}
              </React.Fragment>
            ))}
            {!rows.length && <tr><td colSpan={11} className="pm-sub">—</td></tr>}
          </tbody>
        </table>
      </div>
    </div>
  );
}
