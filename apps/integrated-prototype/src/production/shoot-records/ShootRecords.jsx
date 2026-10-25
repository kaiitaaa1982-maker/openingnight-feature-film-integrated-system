// 撮影の記録の画面（会社ルートの plans/2026-10-22-folder-prod.md の問い1〜7 はすべて A。見た目は docs/design/integrated-system-visual.md）。
// 作品: 撮影日×記録の種類のマス目（札は 済み・要確認・未・遅れ・不要）と全シーンの進み。撮影日: 上から縦に、判定の1行 → 置く → 予定と実績 →
// 撮りこぼし → 部署の申し送り。スマホの幅でも使え、写真はその場で撮って置ける（大きい写真は長い辺 2560px の JPEG に縮めてから送る）
import React, {useCallback, useEffect, useState} from 'react';
import {Notice} from '../../ui/Notice.jsx';
import {CELL_LABELS, DEPARTMENTS, ITEM_LABELS, ITEM_TYPES, KIND_LABELS, RECORD_KINDS, RESULT_LABELS, RESULTS} from './shoot-records-model.mjs';
import './shoot-records.css';

const TONE = {done: 'ok', review: 'stop', open: 'wait', late: 'stop', none: 'none'};
const Tag = ({state}) => <span className={`sr-tag ${TONE[state] ?? ''}`}>{CELL_LABELS[state] ?? '—'}</span>;
const dateLabel = (date) => {
  const at = new Date(`${date}T00:00:00Z`);
  return `${at.getUTCMonth() + 1}/${at.getUTCDate()}（${'日月火水木金土'[at.getUTCDay()]}）`;
};

// DB の時刻（UTC の 'YYYY-MM-DD HH:MM:SS'）を日本時間の「月-日 時:分」で出す
const jst = (value) => {
  const at = new Date(`${String(value).replace(' ', 'T')}Z`);
  return Number.isNaN(at.getTime()) ? '' : new Date(at.getTime() + 9 * 3600 * 1000).toISOString().slice(5, 16).replace('T', ' ');
};

function readAsBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(',')[1] ?? '');
    reader.onerror = () => reject(reader.error ?? new Error('ファイルを読めません'));
    reader.readAsDataURL(blob);
  });
}

// 写真は長い辺 2560px・JPEG に縮める（REC-065）。縮められない形式はそのまま送る
async function shrinkImage(file) {
  if (!/^image\/(jpeg|png|webp)$/.test(file.type) || typeof createImageBitmap !== 'function') return file;
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, 2560 / Math.max(bitmap.width, bitmap.height));
  if (scale === 1 && file.type === 'image/jpeg' && file.size <= 3_000_000) return file;
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  canvas.getContext('2d').drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.85));
  return blob ? new File([blob], file.name.replace(/\.\w+$/, '') + '.jpg', {type: 'image/jpeg'}) : file;
}

export default function ShootRecords({request, workId}) {
  const [dayId, setDayId] = useState(null);
  if (!workId) return <section className="sr"><p className="sr-mute">作品が未選択</p></section>;
  if (dayId != null) return <ShootDay request={request} dayId={dayId} onBack={() => setDayId(null)} onOpen={setDayId} />;
  return <ShootMatrix request={request} workId={workId} onOpen={setDayId} />;
}

function ShootMatrix({request, workId, onOpen}) {
  const [data, setData] = useState(null), [error, setError] = useState(null);
  const load = useCallback(async () => {
    setError(null);
    try { setData(await request(`/production/shoot-records?workId=${workId}`)); } catch (failure) { setError(failure); }
  }, [request, workId]);
  useEffect(() => { load(); }, [load]);
  if (error) return <section className="sr"><Notice error={error} onRetry={load} retryLabel="読み直す" /></section>;
  if (!data) return <section className="sr"><p aria-busy="true">読込中…</p></section>;
  const p = data.progress;
  const open = data.rows.reduce((n, row) => n + Object.values(row.cells).filter((cell) => ['review', 'late'].includes(cell.state)).length, 0);
  return (
    <section className="sr" data-page="shoot-records">
      <div className="sr-verdict">
        <span>撮影日 {data.rows.length}</span>
        <span className={open ? 'sr-now' : ''}>{open ? `要確認 ${open}` : '揃い 済み'}</span>
        <span>結果 {p.scenes - p.none}/{p.scenes}</span>
        <span>完了 {p.shot}</span><span>順延 {p.postponed}</span><span>欠番 {p.dropped}</span>
        {p.unassignedPostponed > 0 && <span className="sr-stop">移し先なし {p.unassignedPostponed}</span>}
      </div>
      {!data.rows.length ? <p className="sr-mute">撮影日なし</p> : (
        <div className="sr-wrap"><table className="sr-table">
          <thead><tr><th>撮影日</th>{RECORD_KINDS.map((kind) => <th key={kind}>{KIND_LABELS[kind]}</th>)}<th>結果</th></tr></thead>
          <tbody>
            {data.rows.map((row) => (
              <tr key={row.dayId} className={row.spare && !row.used ? 'sr-spare' : ''}>
                <td><button type="button" className="sr-link" onClick={() => onOpen(row.dayId)}>{dateLabel(row.shootDate)} {row.unit}</button><span className="sr-sub">{row.label}</span></td>
                {RECORD_KINDS.map((kind) => <td key={kind}><Tag state={row.cells[kind].state} /></td>)}
                <td className="n">{row.result.recorded}/{row.result.assigned}{row.result.postponed > 0 && <span className="sr-tag stop">順延 {row.result.postponed}</span>}</td>
              </tr>
            ))}
          </tbody>
        </table></div>
      )}
    </section>
  );
}

function ShootDay({request, dayId, onBack, onOpen}) {
  const [data, setData] = useState(null), [error, setError] = useState(null), [notice, setNotice] = useState(null), [busy, setBusy] = useState(false);
  const [kind, setKind] = useState('production');
  const [item, setItem] = useState({department: 'production', itemType: 'handover', body: '', sceneId: ''});
  const [notNeeded, setNotNeeded] = useState({kind: '', reason: ''});
  const load = useCallback(async () => {
    setError(null);
    try { setData(await request(`/production/shoot-records/days/${dayId}`)); } catch (failure) { setError(failure); }
  }, [request, dayId]);
  useEffect(() => { load(); }, [load]);

  async function send(path, payload) {
    setBusy(true); setNotice(null);
    try { await request(`/production/shoot-records/days/${dayId}/${path}`, {method: 'POST', body: JSON.stringify(payload)}); await load(); return true; }
    catch (failure) { setNotice(failure); return false; }
    finally { setBusy(false); }
  }
  async function place(files) {
    for (const original of [...files]) {
      const file = await shrinkImage(original);
      const ok = await send('records', {kind, fileName: file.name, mimeType: file.type || 'application/octet-stream', base64: await readAsBase64(file)});
      if (!ok) return;
    }
  }
  async function openOriginal(recordId) {
    try {
      const found = await request(`/production/shoot-records/records/${recordId}/original`);
      const bytes = Uint8Array.from(atob(found.base64), (ch) => ch.charCodeAt(0));
      window.open(URL.createObjectURL(new Blob([bytes], {type: found.mimeType})), '_blank', 'noopener');
    } catch (failure) { setNotice(failure); }
  }

  if (error) return <section className="sr"><Notice error={error} onRetry={load} retryLabel="読み直す" /></section>;
  if (!data) return <section className="sr"><p aria-busy="true">読込中…</p></section>;
  const {row, day, canWrite} = data;
  const otherDays = data.days.filter((d) => d.id !== day.id);
  const departmentsDone = DEPARTMENTS.filter((d) => row.cells[d].state === 'done' || row.cells[d].state === 'none').length;
  const resultRow = (scene, from) => (
    <SceneResult key={`${scene.sceneId}-${from ?? ''}`} scene={scene} from={from} days={otherDays} canWrite={canWrite} busy={busy}
      onSave={(payload) => send('results', {sceneId: scene.sceneId, ...payload})} dayLabel={(id) => { const d = data.days.find((x) => x.id === id); return d ? dateLabel(d.shootDate) : ''; }} />);
  return (
    <section className="sr" data-page="shoot-day">
      <p className="sr-crumb"><button type="button" className="sr-link" onClick={onBack}>← 撮影の記録</button></p>
      <h2>{dateLabel(day.shootDate)} {day.unit}<span className="sr-sub">{day.label}</span></h2>
      <div className="sr-verdict">
        <span>日々スケ <Tag state={row.cells.schedule.state} /></span>
        <span>日報 {departmentsDone}/{DEPARTMENTS.length}</span>
        <span>スクリプター <Tag state={row.cells.script.state} /></span>
        <span>結果 {row.result.recorded}/{row.result.assigned}</span>
      </div>
      {notice && <Notice error={notice} />}

      {canWrite && (
        <div className="sr-block">
          <h3>置く</h3>
          <div className="sr-kinds">{RECORD_KINDS.map((k) => <button key={k} type="button" aria-pressed={kind === k} onClick={() => setKind(k)}>{KIND_LABELS[k]}</button>)}</div>
          <label className="sr-drop">
            <input type="file" accept="image/*,application/pdf,.xlsx,.csv,.txt,audio/*" multiple disabled={busy} onChange={(e) => { place(e.target.files); e.target.value = ''; }} />
            <span>{busy ? '送信中…' : '撮る・選ぶ'}</span>
          </label>
          {notNeeded.kind === kind ? (
            <p className="sr-inline">
              <input placeholder="理由" aria-label="不要の理由" value={notNeeded.reason} onChange={(e) => setNotNeeded({kind, reason: e.target.value})} />
              <button type="button" className="sr-ghost" disabled={busy || !notNeeded.reason.trim()} onClick={async () => { if (await send('records', {kind, notNeeded: true, reason: notNeeded.reason})) setNotNeeded({kind: '', reason: ''}); }}>不要</button>
            </p>
          ) : <button type="button" className="sr-ghost" onClick={() => setNotNeeded({kind, reason: ''})}>不要</button>}
        </div>
      )}

      <div className="sr-block">
        <h3>原本</h3>
        {!data.records.length ? <p className="sr-mute">なし</p> : (
          <table className="sr-table"><tbody>{data.records.map((r) => (
            <tr key={r.id}><td>{KIND_LABELS[r.kind]}</td><td>{r.status === 'placed' ? <button type="button" className="sr-link" onClick={() => openOriginal(r.id)}>{r.fileName}</button> : <span className="sr-mute">不要: {r.reason}</span>}</td>
              <td className="sr-sub">{jst(r.createdAt)}</td></tr>))}</tbody></table>
        )}
      </div>

      <div className="sr-block">
        <h3>シーン</h3>
        {!data.scenes.length && !data.incoming.length ? <p className="sr-mute">なし</p> : (
          <div className="sr-wrap"><table className="sr-table">
            <thead><tr><th>順</th><th>S#</th><th>場所</th><th>予定</th><th>結果</th></tr></thead>
            <tbody>{data.scenes.map((scene) => resultRow(scene))}{data.incoming.map((scene) => resultRow(scene, scene.fromDayId))}</tbody>
          </table></div>
        )}
      </div>

      {data.missed.length > 0 && (
        <div className="sr-block">
          <h3>撮りこぼし</h3>
          {data.missed.map((s) => (
            <p key={s.sceneId}>S#{s.sceneNo} <span className="sr-tag stop">{RESULT_LABELS[s.latest.result]}</span>
              {s.latest.postponedToDayId ? <button type="button" className="sr-link" onClick={() => onOpen(s.latest.postponedToDayId)}>→ {dateLabel(data.days.find((d) => d.id === s.latest.postponedToDayId)?.shootDate ?? day.shootDate)}</button> : <span className="sr-stop"> 移し先なし</span>}</p>
          ))}
        </div>
      )}

      <div className="sr-block">
        <h3>申し送り</h3>
        {DEPARTMENTS.map((d) => {
          const list = data.items.filter((x) => x.department === d);
          return (
            <div key={d} className="sr-dept">
              <p><b>{KIND_LABELS[d]}</b> <Tag state={row.cells[d].state} /></p>
              {list.map((x) => (
                <p key={x.id} className="sr-item"><span className={`sr-tag ${x.itemType === 'incident' || x.itemType === 'problem' ? 'stop' : ''}`}>{ITEM_LABELS[x.itemType]}</span> {x.body}
                  {canWrite && <button type="button" className="sr-ghost sm" disabled={busy} onClick={() => send('items', {department: d, itemType: x.itemType, withdraw: true, replacesId: x.id})}>取り下げる</button>}</p>
              ))}
            </div>
          );
        })}
        {canWrite && (
          <form className="sr-form" onSubmit={async (e) => { e.preventDefault(); if (await send('items', {...item, sceneId: item.sceneId || null})) setItem({...item, body: ''}); }}>
            <select value={item.department} onChange={(e) => setItem({...item, department: e.target.value})} aria-label="部署">{DEPARTMENTS.map((d) => <option key={d} value={d}>{KIND_LABELS[d]}</option>)}</select>
            <select value={item.itemType} onChange={(e) => setItem({...item, itemType: e.target.value})} aria-label="種類">{ITEM_TYPES.map((t) => <option key={t} value={t}>{ITEM_LABELS[t]}</option>)}</select>
            <select value={item.sceneId} onChange={(e) => setItem({...item, sceneId: e.target.value})} aria-label="シーン"><option value="">シーンなし</option>{data.scenes.map((s) => <option key={s.sceneId} value={s.sceneId}>S#{s.sceneNo}</option>)}</select>
            <textarea rows={2} placeholder="本文" aria-label="本文" value={item.body} onChange={(e) => setItem({...item, body: e.target.value})} />
            <button type="submit" disabled={busy || !item.body.trim()}>足す</button>
          </form>
        )}
      </div>
    </section>
  );
}

function SceneResult({scene, from, days, canWrite, busy, onSave, dayLabel}) {
  const latest = scene.latest;
  const [draft, setDraft] = useState({result: latest?.result ?? '', postponedToDayId: latest?.postponedToDayId ?? '', actualStart: latest?.actualStart ?? '', actualEnd: latest?.actualEnd ?? ''});
  const changed = draft.result && (draft.result !== latest?.result || String(draft.postponedToDayId ?? '') !== String(latest?.postponedToDayId ?? '')
    || draft.actualStart !== (latest?.actualStart ?? '') || draft.actualEnd !== (latest?.actualEnd ?? ''));
  return (
    <tr>
      <td className="n">{scene.order ?? '移'}</td>
      <td>S#{scene.sceneNo}{from && <span className="sr-sub">← {dayLabel(from)}</span>}</td>
      <td>{scene.location ?? ''}</td>
      <td className="sr-sub">{scene.plannedStart ? String(scene.plannedStart).slice(11, 16) : ''}</td>
      <td>
        {!canWrite ? (latest ? <span className={`sr-tag ${['postponed', 'partial'].includes(latest.result) ? 'stop' : 'ok'}`}>{RESULT_LABELS[latest.result]}</span> : <span className="sr-tag wait">未</span>) : (
          <div className="sr-result">
            {RESULTS.map((r) => <button key={r} type="button" aria-pressed={draft.result === r} onClick={() => setDraft({...draft, result: r})}>{RESULT_LABELS[r]}</button>)}
            {draft.result === 'postponed' && (
              <select value={draft.postponedToDayId ?? ''} onChange={(e) => setDraft({...draft, postponedToDayId: e.target.value})} aria-label="順延の移し先">
                <option value="">移し先なし</option>{days.map((d) => <option key={d.id} value={d.id}>{dayLabel(d.id)} {d.unit}</option>)}
              </select>
            )}
            <input type="time" value={draft.actualStart} onChange={(e) => setDraft({...draft, actualStart: e.target.value})} aria-label="実績の開始" />
            <input type="time" value={draft.actualEnd} onChange={(e) => setDraft({...draft, actualEnd: e.target.value})} aria-label="実績の終了" />
            <button type="button" className="sr-save" disabled={busy || !changed}
              onClick={() => onSave({result: draft.result, postponedToDayId: draft.result === 'postponed' && draft.postponedToDayId ? Number(draft.postponedToDayId) : null,
                actualStart: draft.actualStart || null, actualEnd: draft.actualEnd || null})}>記録</button>
          </div>
        )}
      </td>
    </tr>
  );
}
