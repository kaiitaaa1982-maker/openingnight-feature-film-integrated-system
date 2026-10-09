// 放送の項目の入力: 取引先の局の種別（地上波・BS・CS・CATV・配信・その他）と、取引先別リストの明細ごとの許諾放送回数・ホールドバック（月）。
// どちらも版で積む（前の版は残る）。理由は必須。保存したら「前 → 後」を出す。
import React, {useCallback, useEffect, useState} from 'react';
import {Notice} from '../ui/Notice.jsx';
import {dateTimeJst} from '../ui/format.mjs';
import {STATION_TYPES} from './window-proposal-model.mjs';

const show = (value, unit = '') => (value === null || value === undefined ? '未確認' : `${value}${unit}`);

// 明細の横に出す: 許諾放送回数とホールドバック
export function BroadcastTermsEditor({request, entryId, readOnly}) {
  const [state, setState] = useState({loading: true});
  const [form, setForm] = useState({licensedRuns: '', holdbackMonths: '', reason: ''});
  const [notice, setNotice] = useState(null);
  const [busy, setBusy] = useState(false);
  const load = useCallback(async () => {
    try {
      const body = await request(`/partner-list-entries/${entryId}/broadcast-terms`);
      setState({body});
      setForm({licensedRuns: body.current?.licensed_runs ?? '', holdbackMonths: body.current?.holdback_months ?? '', reason: ''});
    } catch (error) { setState({error}); }
  }, [request, entryId]);
  useEffect(() => { load(); }, [load]);
  const body = state.body;
  if (state.loading) return <p className="rp-muted">放送の条件を読み込み中…</p>;
  if (state.error) return <Notice error={state.error} onRetry={load} />;
  if (!body.broadcast) return null;
  const current = body.current;
  async function save(event) {
    event.preventDefault();
    setBusy(true);
    try {
      const result = await request(`/partner-list-entries/${entryId}/broadcast-terms`, {method: 'POST', body: JSON.stringify({...form, baseVersion: current?.version_no || 0})});
      setNotice({tone: 'ok', title: `放送の条件を第${result.version}版として保存しました`,
        message: `許諾放送回数 ${show(current?.licensed_runs, '回')} → ${show(result.licensedRuns, '回')}／ホールドバック ${show(current?.holdback_months, 'か月')} → ${show(result.holdbackMonths, 'か月')}`});
      await load();
    } catch (error) { setNotice({error}); } finally { setBusy(false); }
  }
  return (
    <section className="bw-terms" aria-label={`明細 ${entryId} の放送の条件`}>
      <h5>放送の条件（許諾放送回数・ホールドバック）</h5>
      <p className="rp-muted">いまの版: {current ? `第${current.version_no}版・許諾放送回数 ${show(current.licensed_runs, '回')}・ホールドバック ${show(current.holdback_months, 'か月')}（${dateTimeJst(current.created_at)}・${current.created_by_name || ''}）` : 'まだ登録がありません'}。
        ホールドバックは、この契約の放送期間が終わった翌日から他局へ提案しない月数です（放送ウィンドウ提案で塞ぎます）。</p>
      {notice && <Notice tone={notice.tone} title={notice.title} message={notice.message} error={notice.error} onDismiss={() => setNotice(null)} />}
      {!readOnly && body.canEdit && (
        <form className="bw-filters" onSubmit={save} aria-label={`明細 ${entryId} の放送の条件の新しい版`}>
          <label>許諾放送回数（空欄は未確認）<input type="number" min="1" max="9999" inputMode="numeric" value={form.licensedRuns} onChange={(event) => setForm((f) => ({...f, licensedRuns: event.target.value}))} /></label>
          <label>ホールドバック（月・空欄は未確認）<input type="number" min="0" max="120" inputMode="numeric" value={form.holdbackMonths} onChange={(event) => setForm((f) => ({...f, holdbackMonths: event.target.value}))} /></label>
          <label>理由（必須）<input value={form.reason} onChange={(event) => setForm((f) => ({...f, reason: event.target.value}))} placeholder="例: 許諾通知書の条件" /></label>
          <button type="submit" disabled={busy || !form.reason.trim()}>{busy ? '保存しています…' : `第${(current?.version_no || 0) + 1}版として保存`}</button>
        </form>
      )}
      {body.versions.length > 1 && (
        <details><summary>版の履歴（{body.versions.length}版）</summary>
          <ol className="bc-history">{body.versions.map((v) => <li key={v.version_no}><strong>第{v.version_no}版</strong><span>許諾放送回数 {show(v.licensed_runs, '回')}・ホールドバック {show(v.holdback_months, 'か月')}</span><small>理由: {v.reason}・{dateTimeJst(v.created_at)}</small></li>)}</ol>
        </details>
      )}
    </section>
  );
}

// 1つの取引先の局の種別（取引先の詳細と、放送局の種別の一覧に出す）。onSaved は保存の後に一覧を読み直すため
export function StationTypeEditor({request, partnerId, readOnly, onSaved}) {
  const [state, setState] = useState({loading: true});
  const [type, setType] = useState('');
  const [reason, setReason] = useState('');
  const [notice, setNotice] = useState(null);
  const load = useCallback(async () => {
    try {
      const body = await request('/broadcast/station-types');
      const station = body.stations.find((s) => s.partner_id === partnerId) || null;
      setState({station});
      setType(station?.station_type || '');
    } catch (error) { setState({error}); }
  }, [request, partnerId]);
  useEffect(() => { load(); }, [load]);
  if (state.loading) return null;
  if (state.error) return <Notice error={state.error} onRetry={load} />;
  const station = state.station;
  async function save(event) {
    event.preventDefault();
    try {
      const result = await request('/broadcast/station-types', {method: 'POST', body: JSON.stringify({partnerId, stationType: type, reason, baseVersion: station?.version_no || 0})});
      setNotice({tone: 'ok', message: `局の種別を ${station?.station_type ? STATION_TYPES[station.station_type] : '未登録'} → ${STATION_TYPES[result.stationType]} にしました（第${result.version}版）`});
      setReason('');
      await load();
    } catch (error) { setNotice({error}); return; }
    // 一覧の読み直しに失敗しても、保存の失敗の知らせにしない
    try { await onSaved?.(); } catch { /* 一覧はパネルの再試行で読み直せる */ }
  }
  return (
    <section className="bw-terms" aria-label="放送局の種別">
      <h5>放送局の種別</h5>
      <p className="rp-muted">いま: {station?.station_type ? `${STATION_TYPES[station.station_type]}（第${station.version_no}版）` : '未登録'}</p>
      {notice && <Notice tone={notice.tone} message={notice.message} error={notice.error} onDismiss={() => setNotice(null)} />}
      {!readOnly && (
        <form className="bw-filters" onSubmit={save} aria-label="放送局の種別の新しい版">
          <label>局の種別<select value={type} onChange={(event) => setType(event.target.value)}><option value="">選ぶ</option>{Object.entries(STATION_TYPES).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></label>
          <label>理由（必須）<input value={reason} onChange={(event) => setReason(event.target.value)} /></label>
          <button type="submit" disabled={!type || !reason.trim() || type === station?.station_type}>保存</button>
        </form>
      )}
    </section>
  );
}

// 放送局の一覧と種別（放送ウィンドウ提案のタブの下）
export function StationTypesPanel({request, readOnly}) {
  const [state, setState] = useState({loading: true});
  const [editing, setEditing] = useState(null);
  const load = useCallback(async () => { try { setState({body: await request('/broadcast/station-types')}); } catch (error) { setState({error}); } }, [request]);
  useEffect(() => { load(); }, [load]);
  const body = state.body;
  return (
    <details className="card bw-avails">
      <summary><strong>放送局の種別</strong><span className="rp-muted">（取引先の区分に「放送局」がある取引先。地上波・BS・CS・CATV・配信・その他）</span></summary>
      {state.error && <Notice error={state.error} onRetry={load} />}
      {body && (body.stations.length ? (
        <table className="bw-table" aria-label="放送局の種別">
          <thead><tr><th scope="col">取引先</th><th scope="col">局の種別</th><th scope="col">版</th><th scope="col">操作</th></tr></thead>
          <tbody>
            {body.stations.map((s) => (
              <React.Fragment key={s.partner_id}>
                <tr>
                  <td>{s.name}<small className="bc-muted"> {s.code}</small></td>
                  <td>{s.station_type ? STATION_TYPES[s.station_type] : '未登録'}</td>
                  <td>{s.version_no || '—'}</td>
                  <td>{!readOnly && <button type="button" className="secondary" onClick={() => setEditing(editing === s.partner_id ? null : s.partner_id)}>{editing === s.partner_id ? '閉じる' : '直す'}</button>}</td>
                </tr>
                {editing === s.partner_id && <tr><td colSpan={4}><StationTypeEditor request={request} partnerId={s.partner_id} readOnly={readOnly} onSaved={load} /></td></tr>}
              </React.Fragment>
            ))}
          </tbody>
        </table>
      ) : <p className="rp-muted">区分に「放送局」がある取引先がありません。取引先の画面で区分に「放送局」を付けてください。</p>)}
    </details>
  );
}
